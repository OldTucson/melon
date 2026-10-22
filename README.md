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
- [以图搜图生产运行手册](docs/operations/visual-search.md)
- [以图搜图验证记录](docs/verification/2026-10-20-visual-search.md)
