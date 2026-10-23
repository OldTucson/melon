# Melon 上线前加固设计

日期：2026-10-23
状态：已确认

## 背景

`melon` 已完成核心私有图库、商业授权、以图搜图和配色搜索的本地实现与自动化验证，但正式公网发布仍缺少几项仓库侧闭环：当前 Next.js 版本存在已公开的安全漏洞；登录没有持久化限流；主站没有独立的存活与就绪探针；备案、隐私政策和服务协议没有产品入口；主站及维护命令没有完整的 systemd 配置；生产配置没有一条可自动失败的预检命令。

本次加固保持现有私有邀请制。账号继续由管理员通过命令创建和重置密码，不增加自主注册、邮件验证、公开找回密码或第三方登录。

## 目标

- 升级 Next.js 到包含当前已知安全修复的稳定补丁版本，并保持相关 Next.js 包一致。
- 在应用层增加可跨重启、跨进程生效的登录失败限流。
- 为所有应用响应增加与现有 OSS 上传流程兼容的基础安全响应头。
- 提供不泄露内部信息的存活与就绪探针。
- 提供公开可访问的隐私政策、服务协议和备案信息入口。
- 提供主站、预览清理、回收站清理和限流记录清理的 systemd 单元。
- 提供生产环境预检命令和可执行的发布、回滚、备份恢复说明。
- 保持以图搜图生产开关关闭，除非已有明确的人工发布确认。

## 非目标

- 不操作阿里云控制台，不创建 ECS、RDS、OSS、RAM、SLB、WAF、DNS 或证书资源。
- 不填写尚未取得的 ICP 或公安备案号。
- 不替代真实 PostgreSQL 恢复演练、ECS 性能测试、100 图质量基准或 RAM/IMDSv2 验证。
- 不开放公众注册，不增加 MFA、自助找回密码、自助注销或协议接受记录。
- 不在本轮引入外部 Redis、验证码、邮件服务、监控 SaaS 或分析脚本。
- 不把视觉检索服务故障升级为核心图库整体不可用。

## 总体架构

加固分成六个相互独立的边界：依赖安全、认证限流、HTTP 安全与健康检查、合规页面、生产预检、systemd 运行配置。每个边界都提供独立测试；部署文档把它们串成一次可回滚的发布流程。

PostgreSQL 继续作为唯一持久化协调层。登录限流不依赖进程内存，因此服务重启或多进程运行不会清空失败计数。合规页面只读取服务端环境配置，不向浏览器暴露密钥。健康探针只返回粗粒度状态。生产预检只读取配置并输出字段级错误，不连接外部云服务，也不输出任何配置值。

## 依赖安全

升级 `next`、`@next/env` 和 `eslint-config-next` 到同一已修复补丁版本，并更新锁文件。升级前后均以官方 npm registry 执行生产依赖审计；升级后必须不再包含当前 `next@16.4.0` 对应的严重漏洞。

修改 Next.js 配置或路由前，先阅读升级后 `node_modules/next/dist/docs/` 中与 `headers`、Route Handlers、环境变量和 standalone 部署相关的文档，避免沿用旧版约定。

## 登录失败限流

### 数据模型

新增 `auth_login_rate_limits` 表：

- `key_hash`：64 位十六进制 HMAC-SHA256，主键。
- `scope`：`account` 或 `ip`，用于运维统计，不包含原始标识。
- `failure_count`：当前窗口内失败次数。
- `window_started_at`：当前计数窗口起点。
- `blocked_until`：冷却截止时间，可为空。
- `updated_at`：最近更新，用于清理过期记录。

HMAC 使用 `AUTH_SECRET` 派生，输入包含 scope 前缀。表、日志和错误响应均不得保存或输出原始邮箱、原始 IP、密码或凭据正文。

### 规则

- 账号维度：15 分钟内 5 次失败后冷却 15 分钟。
- IP 维度：15 分钟内 20 次失败后冷却 15 分钟。
- 仅在 `AUTH_TRUST_PROXY=true` 时读取由可信反向代理覆盖的 `x-forwarded-for` 或 `x-real-ip`；否则跳过 IP 维度，避免信任客户端伪造头。
- IP 必须通过标准 IP 地址解析；非法值和缺失值不生成 bucket。
- 未知或禁用账号继续走现有固定 Argon2 dummy hash，响应与密码错误一致。
- 已知账号失败时更新账号 bucket；所有带可信 IP 的失败都会更新 IP bucket。
- 成功登录后清除该账号 bucket，并清除本次可信 IP bucket。
- 被限流时仍返回统一的“邮箱或密码不正确”，不暴露账号是否存在、触发的是哪个 bucket 或剩余冷却时间。
- 数据库限流组件不可用时登录失败关闭，不绕过保护；健康就绪探针会同时因数据库不可用而失败。

新增 `auth:cleanup` 命令删除 `updated_at` 超过 24 小时且不再处于冷却期的记录，并由每日 systemd timer 运行。清理可幂等重试，失败以非零状态退出。

## HTTP 安全与健康检查

### 安全响应头

通过 Next.js `headers()` 对所有页面和 API 设置：

- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- 禁用 camera、microphone、geolocation、payment 和 usb 的 `Permissions-Policy`
- 最小 CSP：限制 `base-uri`、`form-action`、`frame-ancestors` 和 `object-src`，同时允许现有同源脚本、内联框架脚本、blob/data 图像和 HTTPS OSS 请求

CSP 不使用 `upgrade-insecure-requests` 代替正确的 HTTPS 配置。生产入口仍必须在反向代理层强制 HTTP 跳转 HTTPS，并确保应用端口只绑定 loopback。

### 健康探针

- `GET /api/health/live`：只证明 Next.js 进程能够响应，返回 `200 {"status":"ok"}`。
- `GET /api/health/ready`：执行轻量 `SELECT 1`；成功返回 200，失败返回 `503 {"status":"unavailable"}`。
- 两个响应都设置 `Cache-Control: no-store`，不返回数据库地址、异常文本、版本、密钥或用户数据。
- readiness 不调用视觉检索服务。视觉检索已有独立 health 和告警，故障时核心图库仍应可服务。

## 合规页面与公开配置

新增公开路由 `/privacy` 和 `/terms`，不要求登录。内容以现有真实行为为准：

- 处理账号邮箱、展示名和密码哈希。
- 处理用户上传的图案源文件、预览、标签、文件夹及授权业务数据。
- 图像搜索查询图只用于当次检索，不持久化为图库资产或搜索历史。
- OSS、数据库和运行日志仅用于提供、保护和维护服务。
- 回收站内容默认保留 30 天；其他数据按账号存续、合同或法定义务保留。
- 用户通过运营者联系方式申请查阅、更正或删除适用数据。
- 用户必须拥有上传内容的必要权利，不得共享账号或上传违法、侵权内容。

新增服务端公开配置：

- `SITE_OPERATOR_NAME`
- `SITE_CONTACT_EMAIL`
- `SITE_LEGAL_EFFECTIVE_DATE`
- `ICP_FILING_NUMBER`，可选
- `PUBLIC_SECURITY_FILING_NUMBER`，可选
- `PUBLIC_SECURITY_FILING_URL`，仅在公安备案号存在时使用

登录页、隐私政策页、服务协议页和已登录设置页展示统一法律入口。ICP备案号只有配置后才显示，并固定链接工信部备案系统；公安备案号与其审核后获得的查询地址同时配置、同时显示。未取得号码时不渲染空占位或虚构编号。

本轮不记录用户点击或接受协议，因为账号由管理员线下邀请创建。正式对外运营前仍需由运营者或法律顾问复核文案和真实主体信息。

## 生产预检

新增 `npm run prod:check`。命令对生产配置执行纯校验并一次性报告所有缺项，任何失败返回非零状态。至少检查：

- `NODE_ENV=production`。
- `APP_ORIGIN` 为无 path/query/fragment 的 HTTPS origin。
- 数据库名称不是 `_test`、`_e2e` 或 `_performance_test` 测试库。
- `AUTH_SECRET` 不是示例值，且 `AUTH_TRUST_PROXY=true`。
- `OSS_ADAPTER=real`，并且没有配置长期 AccessKey。
- 运营者名称、联系邮箱和法律文本生效日期齐全有效。
- 公安备案号和查询 URL 必须成对出现。
- 当 `IMAGE_SEARCH_ENABLED=true` 时，除现有模型、版本、token 配置外，还要求 `IMAGE_SEARCH_RELEASE_APPROVED=true`，作为完成外部生产门禁后的显式人工确认。

预检不读取或打印密钥值，不把人工确认误述为已自动完成 ECS、质量或合规验证。

## systemd 与部署边界

新增以下单元：

- `melon-web.service`：以专用 `melon` 用户运行 standalone Next.js，绑定 `127.0.0.1:3000`，读取 `/etc/melon/web.env`，使用 readiness 探针，崩溃自动重启并设置内存及基础 sandbox 限制。
- `melon-preview-cleanup.service/.timer`：每 5 分钟执行 `npm run preview:cleanup`。
- `melon-trash-cleanup.service/.timer`：每天执行 `npm run trash:cleanup`。
- `melon-auth-cleanup.service/.timer`：每天执行 `npm run auth:cleanup`。

部署目录采用 `/opt/melon/current` 指向当前发布版本。发布包必须包含 standalone server、`.next/static`、`public`（若存在）、迁移文件、维护脚本及维护命令所需依赖。所有服务只从 root 可读的环境文件取得配置，不把密钥写入 unit 文件。

主站 service 只负责应用进程，不内置 TLS。反向代理或 SLB 负责证书、HTTP 到 HTTPS 跳转、覆盖可信代理头和公网限流；安全组只允许反向代理访问应用端口，PostgreSQL 与视觉检索端口不得公网开放。

## 发布与回滚

发布顺序：

1. 对 PostgreSQL 做可恢复备份并记录恢复点。
2. 在新发布目录安装锁定依赖、构建、运行完整验证和 `prod:check`。
3. 保持 `IMAGE_SEARCH_ENABLED=false`，运行数据库迁移。
4. 切换 `/opt/melon/current`，重启主站，验证 live、ready、登录、上传、预览和下载。
5. 启用并检查三个维护 timer，下次触发时间必须可见。
6. 验证真实域名的 HTTPS、安全头、法律页面和可选备案号。
7. 只有外部视觉检索门禁全部通过后，才设置发布确认并按既有运行手册启用视觉检索。

应用回滚只切回上一发布目录并重启，不回退已应用迁移。若迁移后版本无法回滚，保持新数据库结构并关闭受影响功能。视觉检索按既有手册先关闭功能开关，再回退服务版本，不删除索引数据。

## 测试与验收

所有行为变更遵循测试先行：

- 限流纯逻辑单元测试覆盖窗口、阈值、冷却、成功清除、HMAC 和 IP 解析。
- PostgreSQL 集成测试覆盖原子并发计数、跨账号隔离、过期重置和清理。
- 登录集成测试覆盖未知账号、禁用账号、错误密码、被限流账号和成功恢复，所有外部错误保持一致。
- Route Handler 测试覆盖 live/ready、数据库失败、无缓存和无内部错误泄露。
- 页面测试覆盖公开访问、真实数据处理说明、环境配置和备案号条件渲染。
- 配置测试覆盖全部安全响应头和 CSP 必需指令。
- 预检测试覆盖每个拒绝条件，并确认输出不含密钥。
- 文档策略测试覆盖 systemd 路径、loopback 绑定、timer 周期和环境文件边界。

最终验证命令：

```bash
npm audit --omit=dev --registry=https://registry.npmjs.org
npm test
npm run test:integration
npm run typecheck
npm run lint
npm run build
npm run test:e2e
```

目标 ECS 仍需额外执行 `systemd-analyze verify`、服务启动、timer、备份恢复、SLB/WAF、OSS/RAM 和视觉检索生产门禁验证；本地 macOS 的静态检查不能替代这些证据。
