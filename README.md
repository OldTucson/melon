# melon

面向图案设计师的私有 Web 图案资料库。应用使用 Next.js、PostgreSQL 和私有阿里云 OSS，管理 PSD、AI、JPG、PNG 与 Procreate 原文件。

当前已实现资料库、商业授权与私有以图搜图：私有账号登录、浏览器分片直传、JPG/PNG 预览与缩略图、原文件下载、嵌套文件夹、批量整理、回收站、重命名、收藏、标签、组合筛选、排序、明暗主题和租户隔离；商业授权支持普通授权、领域独占、全局买断及收入看板。以图搜图使用自托管 DINOv2、局部特征、PostgreSQL pgvector 和异步单并发索引 worker，默认关闭，必须通过真实图库与生产 ECS 门禁后才启用。

在图案检查器的“商业授权”页记录客户、价格与日期。同一领域可重复普通授权；独占和买断要求核对已有历史，并限制之后的授权。记录可以编辑、作废、恢复，自定义领域可以创建和归档。看板按日期、领域及类型统计有效收入，提供收入趋势、当前商业状态、领域与图案排行及下钻链接。回收站保留授权历史与过去收入，永久删除会同时删除授权历史并重算看板。

## 环境要求

- Node.js 24
- npm
- Docker Desktop，或可用的 PostgreSQL 16+
- Google Chrome；完整 E2E 还需要 Playwright WebKit
- 一个专用、私有的阿里云 OSS Bucket 和按最小权限配置的 RAM/STS 身份

OSS、RAM、CORS、加密与生命周期配置见 [阿里云 OSS 运行配置](docs/operations/aliyun-oss.md)。长期 AccessKey 只能放在本机 `.env.local` 或阿里云默认凭证提供链中，不能提交到 Git；生产环境应使用 ECS 实例 RAM 角色。

以图搜图的镜像、模型挂载、systemd、回填、100 图基准、监控与回滚顺序见[以图搜图生产运行手册](docs/operations/visual-search.md)。模型不会在容器启动时下载，API 只能从宿主机 loopback 访问。

主站正式发布、环境预检、RDS 备份恢复、standalone 制品、systemd 定时任务、TLS 代理和回滚流程见[主站生产运行手册](docs/operations/web-production.md)。每次上线前先在目标环境执行：

```bash
npm run prod:check
```

该命令必须输出 `Production preflight: PASS`；本地开发配置预期会失败，不能据此声称生产环境已经就绪。

## 本地启动

安装依赖并启动 PostgreSQL：

```bash
npm ci
docker compose up -d
```

从示例创建本地配置并填写真实值：

```bash
cp .env.example .env.local
```

初始化数据库并创建第一个私有账号：

```bash
npm run db:migrate
npm run user:create
```

启动开发服务器：

```bash
npm run dev
```

默认地址为 `http://localhost:3000`。忘记密码时可在终端执行 `npm run user:reset-password`。

本地调试以图搜图时，另建 Python 环境并使用锁文件安装：

```bash
uv sync --project services/visual-search --frozen
uv run --project services/visual-search uvicorn melon_visual_search.app:app \
  --host 127.0.0.1 --port 8091
uv run --project services/visual-search melon-visual-search worker
```

先保持 `IMAGE_SEARCH_ENABLED=false` 完成迁移、模型校验、worker 回填和质量基准，再按运行手册启用。Next.js 的 `IMAGE_SEARCH_INTERNAL_TOKEN` 与 Python 的 `VISUAL_SEARCH_INTERNAL_TOKEN` 必须相同。

## 设计灵感分析

登录后访问 `/inspiration`，提交 5–1000 字的设计需求。分析先检索近 30 天公开网络信号，再生成带来源的市场观察、六个设计维度、参考款式与 3–5 个灵感方向。内容不是官方销量或销售排名；公开资料不足时应按页面提示判断证据边界。

功能默认关闭。从阿里云 Model Studio 导出的业务空间 CSV 在本机执行安全配置：

```bash
npm run inspiration:configure -- '/absolute/path/to/model-studio-export.csv'
```

命令只接受一个 CSV 路径，验证同一工作空间的 HTTPS 接口后，以 0600 权限原子更新被 Git 忽略的 `.env.local`，保留其他本地设置。目标文件不能是符号链接，项目目录须归当前用户所有且不可由组或其他用户写入。成功输出只有固定提示，不打印密钥或接口地址。CSV 和 `.env.local` 均含凭据，不得提交、分享或粘贴到日志；API key 仅用于服务端，不能设置为 `NEXT_PUBLIC_*`。

导入器采用保守的环境变量规则：非目标配置中的未转义 `$NAME`、`${NAME}`、默认值和嵌套展开都会被拒绝，即使当前引用看似无害；请先在本机改成明确的字面值。注释和被 `\$` 转义的字面 dollar 可保留，其他变量不能再次引用它们。畸形引号、循环或不支持的展开，以及超过 1 MiB 的配置值也会拒绝导入，原文件保持不变。

真实 Qwen smoke 会调用付费服务，使用固定中文需求验证实际 provider 与来源引用，不输出请求、响应或凭据：

```bash
npm run test:inspiration:real
```

只有 `RUN_REAL_INSPIRATION_TESTS=1` 才会加载 `.env.local` 中明确列出的灵感配置并访问外部服务；普通 `npm test` 跳过此测试。浏览器中可重新打开历史分析，并创建、撤销公开分享；分享链接持有者无需登录即可访问，撤销后旧链接立即失效。

中断的浏览器上传会在会话过期后由维护命令标记为失败，使图案可以再次选择并移入回收站。生产环境每五分钟运行一次，本地也可以手动执行：

```bash
npm run upload:cleanup
```

## 文件夹与回收站

文件夹和图案都只属于创建它们的私有账号，服务端不会接受其他账号的文件夹、图案或回收批次 ID。每个图案最多归属一个文件夹；`folder_id` 为 `NULL` 的图案显示在“未分类”。移动图案或重命名文件夹只修改 PostgreSQL 中的归属或名称，不移动 OSS 对象，对象 key 在整个生命周期内保持稳定。

将文件夹移入回收站会把它的全部子文件夹和其中图案放入同一个回收批次。文件夹批次整体恢复，避免只恢复部分层级。直接删除多个图案也会形成一个批次，但可以在回收站中只恢复所选图案。回收内容保留 30 天；进入回收站时不会删除 OSS 对象，只有永久删除或过期清理才会删除对象。清理完成后图案记录保留为 `deleted` tombstone，不能把“数据库中仍有记录”误判为 OSS 对象仍存在。

生产环境应由一个受监控的调度器至少每天执行一次：

```bash
npm run trash:cleanup
```

该命令使用现有的数据库和 OSS 配置，不需要新增环境变量。它会先恢复执行处于 `deleting` 的任务，再处理超过 30 天的内容；任何非延迟类失败都会以非零退出码结束。若 UI 显示“删除失败”，可点击“重试删除”；无人值守环境则重新运行上面的命令。两种方式都会复用已经保存的 operation ID 并从当前阶段继续，不能为同一个 `deleting` 批次手工创建新的 operation ID。应对非零退出、持续的 `deleting` 状态和 OSS 删除错误设置告警。

## 数据库迁移

现有数据库升级前先做可恢复备份并安排维护窗口，然后使用与应用相同的 `DATABASE_URL` 执行：

```bash
npm run db:migrate
```

`0002_melon_folders_bulk_trash.sql` 新增文件夹、单一 `folder_id` 归属和回收站字段；已有图案的 `folder_id` 默认为 `NULL`，因此迁移后进入“未分类”。后续的 `0003_strange_bloodscream.sql` 为在途上传增加永久删除前的凭据失效栅栏。迁移完成后再部署应用和清理调度器，并检查迁移记录、外键及索引。空数据库也直接运行同一条 `db:migrate` 命令创建完整结构，然后执行 `npm run user:create`；部署时不要用 `db:generate` 代替已审查的迁移。

日志、错误上报、测试产物和截图绝不能记录 AccessKey、STS token、签名 URL 或图案源文件内容。生产环境继续使用最小权限的实例 RAM 角色；本地长期凭据只允许存在于被 Git 忽略的 `.env.local` 或默认凭证提供链中。

## 验证

基础质量门禁：

```bash
npm test
npm run test:integration
npm run typecheck
npm run lint
npm run build
```

数据库集成测试使用 `postgres://melon:melon@localhost:55432/melon_test`。`compose.yaml` 提供相同的本地端口和账号。

浏览器 E2E 使用独立的 `melon_e2e` 数据库，并在真实 OSS 中创建随机 UUID 隔离对象；测试结束后会按数据库记录清理对象。先确保 `.env.local` 已配置、服务端 RAM 身份拥有文档要求的 Bucket 级 `oss:ListObjects`、Bucket CORS 允许实际测试 Origin（默认 `http://127.0.0.1:3210`），再执行。若预检返回 `E2E_OSS_LIST_PERMISSION_MISSING`，请按[服务端运行身份](docs/operations/aliyun-oss.md#服务端运行身份)补齐权限，不要把列举权限加到浏览器上传角色。

```bash
npx playwright install webkit
npm run test:e2e
```

商业授权与看板浏览器验证不访问 OSS，使用独立的 `melon_commercial_e2e` 数据库和 `http://127.0.0.1:3211`。它会拒绝任何资产记录，只生成元数据，并分别在 Chrome、桌面 WebKit、1024×1366 WebKit 上执行；看板覆盖浅色和夜间主题。永久删除的浏览器断言止于影响统计与危险确认，实际清除及收入重算由 fake-OSS 集成测试覆盖。

```bash
npm run test:e2e:commercial
```

两个浏览器命令都不会复用已有服务，使用专用 `.next-e2e` 构建目录；不要同时运行两套浏览器测试。可用 `E2E_PORT=3212` 覆盖端口、`E2E_DATABASE_URL` 覆盖测试库（名称必须以 `_e2e` 结尾）。传统 OSS E2E 改端口时还需配置对应 CORS origin。不要将测试库指向应用数据库。

例如保留 3210 开发服务并在已加入 OSS CORS 的 3212 运行传统 E2E：

```bash
E2E_PORT=3212 E2E_DATABASE_URL=postgres://melon:melon@127.0.0.1:55432/melon_legacy_e2e npm run test:e2e
```

目标规模验证只写入显式指定、名称以 `_performance_test` 结尾的测试库，不读取 `.env.local`，也不创建 OSS 对象。它迁移测试库并重建专用测试所有者下的 10,000 个图案和 100,000 条授权，不清空其他所有者的数据；输出真实看板查询的 JSON 执行计划摘要。年度与领域查询必须命中预期索引；全时间及当前状态允许按所有者限定的全量扫描，未限定所有者的图案/授权扫描会失败。

```bash
PERFORMANCE_DATABASE_URL=postgres://melon:melon@127.0.0.1:55432/melon_performance_test npm run seed:performance
```

本次运行结果与外部依赖边界见[商业授权验证记录](docs/verification/2026-10-08-commercial-authorizations.md)。

真实 OSS 适配器测试默认跳过。需要显式验证 STS、断点续传、HEAD/Range、签名下载和删除时执行：

```bash
RUN_REAL_OSS_TESTS=1 npm run test:integration -- src/features/storage/oss-adapter.real.integration.test.ts
```

## 文档

- [产品与技术设计](docs/superpowers/specs/2026-10-08-melon-web-design.md)
- [商业授权与数据看板设计](docs/superpowers/specs/2026-10-08-melon-commercial-authorization-dashboard-design.md)
- [MVP 实施路线图](docs/superpowers/plans/2026-10-08-melon-mvp-roadmap.md)
- [第一阶段实施计划](docs/superpowers/plans/2026-10-08-melon-01-foundation-library.md)
- [阿里云 OSS 运行配置](docs/operations/aliyun-oss.md)
- [主站生产运行手册](docs/operations/web-production.md)
- [以图搜图生产运行手册](docs/operations/visual-search.md)
- [以图搜图验证记录](docs/verification/2026-10-20-visual-search.md)

## 编辑式灵感报告：候选发布与回滚门禁

生产保持 `INSPIRATION_ENABLED=false`、`INSPIRATION_WEB_VISUALS_ENABLED=false`，先完成 schema 迁移与代码部署。已有私邀账户政策不变；本阶段不开放注册或生成图片。视觉增强失败不得影响已完成的文字报告，刷新失败应保留上一个完整视觉集合。

候选环境配置服务端 `DASHSCOPE_API_KEY`、`DASHSCOPE_WEB_SEARCH_AGENT_ID`（`aid-…`）和 `DASHSCOPE_WEB_SEARCH_AGENT_VERSION`（固定为已验证的 `beta` 或 `release`）。不要使用 `NEXT_PUBLIC_*`，不要把凭据、Agent 请求/响应或图片下载地址写进浏览器、截图、CI 附件和日志。只有候选环境的真实报告验收时才启用 `INSPIRATION_ENABLED=true`、`INSPIRATION_WEB_VISUALS_ENABLED=true`；生产开关须等下面全部门禁通过。

先运行完整离线门禁（只用隔离测试数据库，不访问 provider 或真实 OSS）：

```bash
npm test
npm run test:integration
npm run typecheck
npm run lint
npm run build
npm run test:e2e -- tests/e2e/inspiration-document.spec.ts --project=chromium-desktop
git diff --check
```

若本机 `.env.local` 启用了尚未获生产批准的功能，原样 `npm run build` 会被环境 schema 拒绝（例如 `IMAGE_SEARCH_RELEASE_APPROVED`）。保留该安全校验，不伪造批准、不修改本地凭据；关闭功能的候选制品使用下列显式命令，并分别记录原始失败与候选构建结果：

```bash
IMAGE_SEARCH_ENABLED=false INSPIRATION_ENABLED=false INSPIRATION_WEB_VISUALS_ENABLED=false npm run build
```

该 spec 直接调用时自动使用既有 metadata-only Playwright 设置；数据库名必须以 `_e2e` 结尾。fixture 只写研究、完成的任务、来源和私有素材元数据，媒体为本地固定 PNG，仅拦截同源应用图片字节路由；不会上传、下载远程图片或运行真实 OSS。测试前后使用仓库隔离数据库保护，资源鉴权拒绝与撤销请求不经过图片拦截。端口占用时用 `E2E_PORT=空闲端口` 重跑，不终止其他进程。不要对生产或非测试数据库执行 fixture。截图保存于 `test-results/inspiration-document-*/`；人工检查登录/分享状态在 1512×982、1280×800、390×844 下的页面顶部、商品区及完整共享文档，确认无重叠、裁切、空白媒体或来源链接丢失。测试同时要求 0/1/4/8 图、960px 左右阅读宽度、3→2→1 商品列、键盘预览/焦点恢复、失败图片等比例占位、私有素材隔离及撤销 404。

经明确批准一次付费请求后，在候选环境终端中安全注入上面的三个 Agent 变量，再运行：

```bash
npm run test:inspiration:web-real
```

这条命令显式设置 `RUN_REAL_INSPIRATION_WEB_TESTS=1`，最多发送一次 Agent 请求，无重试、不下载候选图片，仅校验结构化图片候选；输出只含数量和格式校验后的稳定请求 ID。默认 `npm test` 跳过真实分支，只运行离线安全契约。该测试不自动读取 `.env.local`，缺失或无效配置在请求前以固定错误码终止；凭据存在本身不代表同意付费。禁止以重新运行循环补足候选，必须先评审失败原因并重新授权。通过结构化 smoke 仍不代表真实图片、商品可靠性或来源真实性通过。

随后执行候选环境真实端到端验收（人工浏览器；没有把生产数据接入离线 E2E 的快捷命令）：

1. 启动独立候选实例，例如 `npm run start -- --hostname 127.0.0.1 --port 3220`，通过受控候选入口使用私邀测试账号创建一份真实报告。确认文字先可读且只自动启动一次视觉增强；最终至少有一个 hero、一个 evidence、一个可靠商品图片。无可靠商品即发布失败，不得伪造卡片。
2. 逐一打开原始来源页面，核对商品名称、品牌/网站、图片与上下文；不得把 Agent 标题当作可靠商品事实。确认应用图片请求只走本地字节路由，浏览器无 provider HTML、远程图片地址、内部存储信息或原始失败信息。
3. 刷新视觉并确认 pending/失败期间旧集合保留、完成后整体替换；验证 owner 可读、跨用户不可读，未登录有效分享可读但无私有图库匹配。撤销分享后旧页面及资产地址均为 404；删除分析后视觉行级联删除，研究对象执行 best-effort 清理，已保存图库素材保持完整。
4. 对真实报告的登录与分享页面分别捕获三种目标视口截图并人工逐张检查。离线 fixture 截图不能替代这一步。保留不含敏感数据的验收记录和稳定失败码。
5. schema、离线全部检查、一次 Agent smoke、真实 hero/evidence/可靠商品、每个来源页、owner/share 字节、撤销、删除清理及全部视口截图全部通过后，才做蓝绿切流。先验证关闭开关的绿色实例，保留旧版本和可恢复数据库备份，再按私邀范围启用生产 `INSPIRATION_WEB_VISUALS_ENABLED`（以及文字功能开关），观察后扩大私邀范围。

OSS 为独立外部门禁：bucket 必须私有。服务端角色只获得目标 bucket 研究对象范围所需的 `GetObject`、`PutObject`、`DeleteObject` 最小权限；仅在明确使用列表清理时增加限范围列举权限，禁止公共读、宽泛 `oss:*` 或把研究对象授权给浏览器上传角色。禁止使用生命周期到期规则删除 `research/` 或 `concept-sets/` 已完成对象：保留的概念引用可能长期用于衍生重试，数据库 pin 无法阻止 OSS 自动过期。候选与生产 bucket 均必须核验没有更广的 bucket/前缀规则使 `research/` 或 `concept-sets/` 到期；未核验不得启用。被新任务取代且无引用的研究键只由引用感知应用清理删除；报告删除由无级联外键的持久清理 manifest 记录精确研究范围和集合 IDs，定时清理完成后才移除 manifest。不要用未实现的对象标签规则代替此门禁。

报告删除事务在删除集合和分析前写入持久清理 manifest；数据库 BEFORE DELETE 触发器也覆盖旧版本直接删除分析的路径。即时对象删除仍为 best-effort，失败或进程退出后由定时任务按照 manifest 精确列举重试，包括已经没有输出/视觉行的孤儿。所有前缀经再次列举确认空、删除逐键确认且租约仍有效后才完成 manifest。监控只能记录稳定错误码、任务耗时、导入数量、失败数量、内存和 OSS 增长汇总，不记录 query/需求文本、远程 URL（含 query string）、provider body、对象 key、owner ID、凭据或授权头。

回滚首先将 `INSPIRATION_WEB_VISUALS_ENABLED=false` 并按部署方式重启/滚动更新，使新视觉导入与刷新停止；保留已完成文字及既有授权访问，不清空数据、不撤销已保存图库。必要时切回蓝色旧版本，保持私邀入口且概念生成继续禁用，验证文字历史与分享撤销仍正常。旧 web release 回滚必须保留 additive manifest 表、触发器和延迟 FK，并运行兼容版本的 cleanup binary/timer；若事故期间停止清理，明确保留 manifests 等待下一次兼容发布处理，绝不执行破坏性降级 SQL。回滚不等于删除对象，也不能取消已经在途的工作；继续监控稳定码/数量与持久清理 manifest 积压，修复并重过全部门禁后再启用。

## 灵感概念套图运维

概念生成默认关闭：`INSPIRATION_CONCEPT_IMAGES_ENABLED=false`。迁移先于 web/worker 启动，生产启用还要求 `INSPIRATION_CONCEPT_RELEASE_APPROVED=true`、`qwen-image-3.0-pro`、同一 workspace 的 HTTPS 原生/OpenAI 地址、真实私有 OSS 以及显式 `INSPIRATION_CONCEPT_WORKER_ID`。概念 worker 状态独立于主站 readiness。

```bash
npm run prod:check
npm run inspiration:concept-status
npm run inspiration:concept-cleanup -- --dry-run
npm run inspiration:concept-cleanup
```

状态命令仅返回心跳年龄、健康状态、队列计数和最老排队年龄；超过 90 秒或缺失心跳返回非零。清理命令仅接受无参数或 `--dry-run`，保留至少 24 小时，默认每批最多 25 个集合、25 个研究对象键和 25 份报告 manifest；dry-run 不修改数据库或对象。生产使用 `/etc/melon/web.env` 与每日 systemd timer。完整安装、灰度验收、费用核对和非破坏回滚步骤见[概念套图上线与运行](docs/operations/web-production.md#概念套图上线与运行)。既有阶段“生成禁用”要求在该独立门禁完成前继续生效。

### 概念套图验证：离线与计费严格分开

离线浏览器门禁使用独立 `melon_concepts_e2e` 数据库和默认端口 3214。直接指定 `inspiration-concepts.spec.ts` 自动选择 metadata-only，绝不运行 legacy OSS setup。创建、重试、版本上限、删除、分享撤销和跨租户拒绝走真实应用/API/数据库；worker 阶段由测试数据库推进，图片/下载响应使用本地非均匀 PNG。没有生成 worker、真实提供方请求或 OSS 请求。浏览器拒绝任何外部请求并要求零 page/console error。

```bash
E2E_METADATA_ONLY=1 npm run test:e2e -- tests/e2e/inspiration-concepts.spec.ts --project=chromium
npm run test:e2e:concepts-disabled
```

第一条覆盖 1512×982、1440×900、768×1024、390×844 的 owner/share、零方案、排队、部分失败、重试、完成、三版本、抽屉和预览；第二条以关闭生成开关的独立服务器启动验证历史成图仍可读。截图在 `test-results/concepts-enabled/` 与 `test-results/concepts-disabled/`，同一模式的后一次 Playwright 运行会覆盖对应输出目录，保存验收资料后再重跑。图片解码/像素、3:4/3:4/4:3 比例、稳定几何、阅读宽度、溢出、焦点可见与恢复均自动检查。浏览器下载使用拦截字节；真实下载鉴权和响应头由路由/资源集成测试验证，真实 OSS/账单不属于这条门禁。

真实三阶段测试默认跳过，包括常规 `npm test`。只有另外获得一次计费授权、在受控环境核对私有 OSS 权限后才能执行：

```bash
npm run test:inspiration:concept-real
```

脚本显式设置 `RUN_REAL_INSPIRATION_CONCEPT_TESTS=1`，最多提交一张草图、一张效果图和一张款式图，不重试付费提交；每阶段最多 24 次有界退避查询，总请求阶段预算 12 分钟。固定本地参考图最多两张，衍生输入为已持久化草图加这两张参考。模型固定 `qwen-image-3.0-pro`，尺寸为 1536×2048、1536×2048、2048×1536，导入后解码验证并在 finally 删除烟测对象。失败仅输出固定错误，不打印提示词、provider ID、URL、凭据、对象键或 Base64；清理失败同样使测试失败。配置在 opt-in 后才读取环境及 `.env.local` 白名单，进程环境优先；凭据存在不代表计费授权。

**待发布门禁：**目标 Linux systemd verify/实际环境探针、上述真实提供方与私有 OSS/账单烟测、一次受控生产套图（草图提交后重启 worker，两个衍生图仍完成）均须另行执行并留存脱敏证据。离线 PASS 不允许打开生产 UI；在这些门禁完成前保持 `INSPIRATION_CONCEPT_IMAGES_ENABLED=false` 和 `INSPIRATION_CONCEPT_RELEASE_APPROVED=false`。
