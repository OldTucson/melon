# melon MVP 实施路线图

- 日期：2026-10-08
- 依据：[主设计](../specs/2026-10-08-melon-web-design.md)与[商业授权设计](../specs/2026-10-08-melon-commercial-authorization-dashboard-design.md)
- 状态：待执行

## 1. 为什么拆成四份计划

melon 的 MVP 同时包含账号与租户隔离、OSS 大文件链路、商业授权事务、格式预览、离线同步和生产运维。它们共享数据模型，但风险和验收方式不同。拆成四个阶段可以让每个阶段都形成可运行、可测试、可回滚的增量，并避免在基础链路尚未稳定时同时调试预览、离线和商业规则。

## 2. 执行顺序

1. [01 基础账号、图库与 OSS](2026-10-08-melon-01-foundation-library.md)
   - 交付私有登录、主题、PostgreSQL 基础模型、标签与图库、JPG/PNG 基础预览、OSS 直传/续传和原文件下载。
   - 阶段结束时已经是可供单人使用的在线图案库。
2. [02 商业授权与数据看板](2026-10-08-melon-02-commercial-authorizations-dashboard.md)
   - 交付授权领域、普通授权/领域独占/全局买断、商业筛选、收入看板和永久删除商业数据语义。
   - 依赖阶段 01 的用户、图案、查询外壳与数据库事务工具。
3. [03 专业格式预览](2026-10-08-melon-03-format-previews.md)
   - 交付 PSD 合成图、PDF-compatible AI 首页、Procreate 手动预览及 worker 安全边界。
   - 依赖阶段 01 的派生资产上传协议，不依赖离线同步。
4. [04 离线同步与生产加固](2026-10-08-melon-04-offline-production-hardening.md)
   - 交付 Dexie 镜像、outbox、PWA、冲突收敛、回收站清理、部署、安全与完整性能验收。
   - 必须在前三阶段的数据结构稳定后执行。

## 3. 跨阶段不可破坏的约束

- Node.js 固定为 24 LTS；依赖安装后提交 `package-lock.json`，后续不使用浮动版本更新来夹带功能变更。
- PostgreSQL 是业务事实来源；浏览器缓存、聚合结果和 OSS object key 都不能替代数据库授权。
- 所有业务查询从 Auth.js 会话取得 `ownerId`；客户端传入的 owner 字段一律忽略。
- 原文件不经过 Next.js；浏览器只获得当前用户、当前图案前缀的短期 STS。
- `ready` 后的原文件不可替换；新版作为新 `Pattern` 上传。内容哈希只用于校验与续传，允许相同内容重复入库，不自动去重。
- OSS 分片初始化、上传分片和完成操作只需要 `oss:PutObject`；断点核对使用 `oss:ListParts`，主动放弃使用 `oss:AbortMultipartUpload`。不得写入不存在的细粒度 RAM action，也不得授予 `oss:*`。
- 金额始终以人民币整数分处理；商业写入只在线执行，并锁定 `Pattern` 行验证 `commercialVersion`。
- 浅色/夜间主题共用语义 token；不能在业务组件中散落硬编码主题色。
- 每个阶段采用红-绿-重构节奏，先证明测试会失败，再写最小实现；每个任务单独提交。
- 真实 OSS 测试只使用隔离测试 Bucket/前缀。没有环境时记录 `NOT RUN`，不能改用生产数据，也不向聊天或仓库提交 AccessKey。

## 4. 统一质量门槛

每个阶段最后都运行：

```bash
npm test
npm run test:integration
npm run typecheck
npm run lint
npm run build
npm run test:e2e
```

除明确标注为可选的真实 OSS smoke test 外，任一命令失败都不能进入下一阶段。阶段验证记录写入 `docs/verification/`，包含命令、退出码、测试数量、浏览器项目和时间，不写没有证据的“已通过”。

## 5. 官方实施参考

- [Next.js `proxy.ts` 文件约定](https://nextjs.org/docs/app/api-reference/file-conventions/proxy)
- [Auth.js Credentials 登录](https://authjs.dev/getting-started/authentication/credentials)
- [Drizzle Kit 迁移流程](https://orm.drizzle.team/docs/kit-overview)
- [阿里云 OSS Multipart Upload](https://www.alibabacloud.com/help/en/oss/user-guide/multipart-upload)
- [`@webtoon/psd` API](https://github.com/webtoon/psd/blob/main/README.md)
- [PDF.js 渲染示例](https://mozilla.github.io/pdf.js/examples/index.html)
- [Serwist Worker 导出与运行时缓存](https://serwist.pages.dev/docs/next/worker-exports)

实施每个阶段时先核对对应官方页面；若锁定依赖版本与文档当前版本不一致，以锁文件版本的 API 和测试结果为准，并在计划中记录偏差。

## 6. 规格覆盖矩阵

| 已确认要求 | 实施位置 |
| --- | --- |
| 私有账号、首次改密、主题偏好、租户隔离 | 01 / Tasks 2–5 |
| Mac 优先工作台、查询、标签、收藏、虚拟滚动 | 01 / Tasks 5–6 |
| 私有 OSS、STS、分片进度、取消、重试、续传、下载 | 01 / Tasks 7–10 |
| JPG/PNG 预览与安全派生资产 | 01 / Tasks 9–10 |
| 普通授权、领域独占、全局买断、自定义领域 | 02 / Tasks 1–5 |
| 商业摘要、筛选、收入趋势、当前状态与排行 | 02 / Tasks 6–8 |
| 回收站保留与 C 永久删除统计回退 | 02 / Task 9；04 / Task 5 |
| PSD、PDF-compatible AI、Procreate 手动预览 | 03 / Tasks 1–5 |
| 离线缓存、标签 outbox、多设备冲突收敛 | 04 / Tasks 1–4、7 |
| 清理任务、安全、Docker/Nginx、完整验收 | 04 / Tasks 5–8 |

## 7. 计划之外

四份计划不包含公开注册、团队协作、移动端专用交互、在线编辑源文件、文件版本历史、CRM/订单/收款、AI 自动打标或原生 App。这些需求必须另行设计，不能在实施阶段顺手加入。
