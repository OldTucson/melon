# melon

面向图案设计师的私有 Web 图案资料库。应用使用 Next.js、PostgreSQL 和私有阿里云 OSS，管理 PSD、AI、JPG、PNG 与 Procreate 原文件。

当前已完成第一阶段资料库 MVP：私有账号登录、浏览器分片直传、JPG/PNG 预览与缩略图、原文件下载、嵌套文件夹、批量整理、回收站、重命名、收藏、标签、组合筛选、排序、明暗主题和租户隔离。商业授权与数据看板是下一阶段。

## 环境要求

- Node.js 24
- npm
- Docker Desktop，或可用的 PostgreSQL 16+
- Google Chrome；完整 E2E 还需要 Playwright WebKit
- 一个专用、私有的阿里云 OSS Bucket 和按最小权限配置的 RAM/STS 身份

OSS、RAM、CORS、加密与生命周期配置见 [阿里云 OSS 运行配置](docs/operations/aliyun-oss.md)。长期 AccessKey 只能放在本机 `.env.local` 或阿里云默认凭证提供链中，不能提交到 Git；生产环境应使用 ECS 实例 RAM 角色。

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

浏览器 E2E 使用独立的 `melon_e2e` 数据库，并在真实 OSS 中创建随机 UUID 隔离对象；测试结束后会按数据库记录清理对象。先确保 `.env.local` 已配置、服务端 RAM 身份拥有文档要求的 Bucket 级 `oss:ListObjects`、Bucket CORS 允许 `http://127.0.0.1:3210`，再执行。若预检返回 `E2E_OSS_LIST_PERMISSION_MISSING`，请按[服务端运行身份](docs/operations/aliyun-oss.md#服务端运行身份)补齐权限，不要把列举权限加到浏览器上传角色。

```bash
npx playwright install webkit
npm run test:e2e
```

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
