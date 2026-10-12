# melon

面向图案设计师的私有 Web 图案资料库。应用使用 Next.js、PostgreSQL 和私有阿里云 OSS，管理 PSD、AI、JPG、PNG 与 Procreate 原文件。

当前已完成第一阶段资料库 MVP：私有账号登录、浏览器分片直传、JPG/PNG 预览与缩略图、原文件下载、重命名、收藏、标签、组合筛选、排序、明暗主题和租户隔离。商业授权与数据看板是下一阶段。

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

浏览器 E2E 使用独立的 `melon_e2e` 数据库，并在真实 OSS 中创建随机 UUID 隔离对象；测试结束后会按数据库记录清理对象。先确保 `.env.local` 已配置、Bucket CORS 允许 `http://127.0.0.1:3210`，再执行：

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
