# melon 图案管理 Web 应用设计

- 日期：2026-10-08
- 状态：已书面确认，可进入实施计划
- 项目名称：melon（暂定）

## 1. 背景与目标

为图案设计师提供一个私有的 Web 图案资料库，用来集中管理 PSD、AI、JPG、PNG 和 Procreate 原文件。系统以 Mac 桌面浏览器为第一优先级，未来可在不重写业务层的前提下适配 iPad 和 iPhone 浏览器。

MVP 必须完成以下闭环：

1. 上传原文件到阿里云 OSS，并显示进度、取消和失败重试。
2. 为可解析格式生成预览图和缩略图；不可解析格式仍可管理和下载。
3. 编辑名称、收藏状态和标签，并按名称、文件名、格式、标签、状态等条件查询。
4. 下载原文件，保留原始文件名。
5. 在断网时查看已缓存的元数据和缩略图、修改标签，恢复网络后自动同步。
6. 每个用户的数据完全隔离；不开放公开注册。
7. 以图案为主体记录普通授权、领域独占和全局买断，并按商业状态筛选。
8. 通过数据看板查看授权收入趋势、图库商业状态、授权领域排行和高收入图案。

目标规模为单用户约 10,000 个图案。常见文件小于 100 MB，MVP 单文件硬上限为 200 MB。

## 2. 已确认约束

### 2.1 产品边界

- 只做 Web，不做 App Store 上架，不做 Electron、React Native 或原生客户端。
- 优先优化 Mac 桌面浏览器；iPad 和 iPhone 的完整响应式体验属于后续阶段。
- 每个 `Pattern` 只对应一个用户上传的原文件。
- 预览图和缩略图是系统派生资产，不算额外原文件。
- 原文件完成上传后在 MVP 中不可替换；新版设计应创建新的图案记录。文件版本历史不在 MVP 范围内。
- 允许内容相同的文件重复上传。内容哈希用于完整性、重选续传和问题排查，不自动去重。
- 不做团队协作、共享链接、评论、审批、AI 自动打标、图层编辑、批量 ZIP 下载或在线编辑源文件。
- 不解析 Procreate 文件内容；用户可后补 JPG/PNG 预览图。
- 商业授权不扩展为 CRM、订单、合同附件、收款、发票、到期提醒或多币种系统。
- 不统计图片修改频率。
- 商业授权和看板的完整规则见[商业授权与数据看板设计](2026-10-08-melon-commercial-authorization-dashboard-design.md)。

### 2.2 账号边界

- 不提供注册页面和公开注册 API。
- MVP 账号由部署管理员通过受控命令创建，并生成初始密码；用户首次登录后必须修改密码。
- 用户可以修改自己的密码；管理员可通过受控命令重置密码。
- 用户只能访问自己的图案、标签、上传会话、同步日志和 OSS 对象。

## 3. 技术方案

### 3.1 技术栈

| 层级 | 选择 | 用途 |
| --- | --- | --- |
| Web 框架 | Next.js App Router + TypeScript | 页面、同源 API、鉴权入口和部署单元 |
| UI | Tailwind CSS + Radix UI/shadcn + Lucide | 可访问的基础控件、桌面工作台和图标 |
| 服务端数据 | PostgreSQL + Drizzle ORM | 用户、图案、标签、上传和同步数据 |
| 请求与缓存 | TanStack Query | 在线查询、失效和后台刷新 |
| 本地数据库 | IndexedDB + Dexie | 离线元数据、同步游标、outbox 和上传检查点 |
| 临时 UI 状态 | Zustand | 选择集、面板状态、视图模式等非持久状态 |
| PWA | Serwist | App Shell 与静态资源缓存、离线入口 |
| 校验 | Zod | API 输入、环境变量和客户端表单校验 |
| 鉴权 | Auth.js Credentials + Argon2id | 私有账号登录和安全密码哈希 |
| OSS | `ali-oss` + STS | 浏览器直传、分片上传和断点续传 |
| PSD 预览 | `@webtoon/psd` | Web Worker 中提取合成图 |
| AI 预览 | PDF.js | 渲染 PDF-compatible AI 的第一页 |
| 虚拟列表 | TanStack Virtual | 10,000 条数据下保持有界 DOM 数量 |
| 测试 | Vitest + Testing Library + Playwright | 单元、组件、集成和端到端测试 |

### 3.2 总体架构

```text
Mac / iPad / iPhone 浏览器
  ├─ Next.js 客户端工作台
  ├─ Web Workers：哈希、PSD/AI/位图预览
  ├─ Dexie：元数据、outbox、上传检查点
  └─ Cache Storage：缩略图
          │
          ├─ HTTPS / same-origin
          ▼
Nginx ── Next.js 单体服务
          ├─ Auth.js 会话与权限校验
          ├─ Pattern / Tag / Authorization / Sync API
          ├─ STS 临时凭证签发
          └─ 下载签名与上传完成校验
             │                 │
             ▼                 ▼
       RDS PostgreSQL     私有阿里云 OSS
```

浏览器通过短期 STS 凭证直接向 OSS 上传大文件，文件内容不经过 Next.js 进程。Next.js 只负责身份、授权、元数据、同步、STS 和完成校验，因此不会被 100 MB 级请求占满内存或带宽。

整个系统先按一个可独立部署的单体实现。模块边界清晰，但 MVP 不拆微服务，也不增加 Redis、消息队列或独立预览服务。

## 4. 信息架构与交互

### 4.1 页面路由

- `/login`：登录和首次改密。
- `/library`：主工作台，包含全部图案、最近使用、未打标签和收藏视图。
- `/dashboard`：商业授权收入与图库状态看板。
- `/trash`：30 天内可恢复的图案。
- `/settings`：个人资料、密码、主题、授权领域、缓存占用和本地缓存清理。

未登录用户只能进入 `/login`。系统没有 `/register`。

### 4.2 桌面工作台

主页面采用连续工作区，而不是多层卡片：

- 顶栏：全局搜索、上传入口、同步/离线状态、账号菜单。
- 左侧栏：固定约 220 px，包含图库、最近、未打标签、收藏、回收站、数据看板和标签列表。
- 中央区：工具栏、筛选条件、排序、网格/列表切换以及虚拟滚动结果。
- 右侧检查器：选中单个图案时显示，宽约 340 px，可收起；“基本信息”编辑名称、收藏和标签，“商业授权”管理该图案的一对多授权历史。
- 底部上传队列：默认折叠为状态条，展开后显示每个任务的阶段、速度、进度、取消、重试和“重新选择文件继续”。

关键操作：

- 单击选择，双击打开大图预览。
- `Command` 多选离散项目，`Shift` 连续选择。
- 空格键快速预览，`Esc` 关闭。
- 文件可拖入中央区，也可通过上传按钮选择。
- 多选时右侧检查器切换为批量加/减标签、收藏和移入回收站操作。
- 删除先进入回收站；30 天内可恢复，之后由后台清理任务永久删除。

### 4.3 查询行为

- 搜索匹配图案名称和原始文件名，不搜索 PSD/AI 图层文字。
- 可按标签、格式、收藏、预览可用性、上传状态、商业状态、授权领域和创建/更新时间筛选。
- 同时选择多个标签时默认采用“全部匹配”，用户可切换为“任一匹配”。
- 支持按更新时间、创建时间、名称和文件大小排序。
- 服务端使用游标分页；客户端虚拟滚动，不把 10,000 个条目同时挂到 DOM。
- URL 保存可分享给自己的筛选状态，但链接不会绕过登录或数据权限。

### 4.4 后续移动端适配

未来移动网页保留同一数据与同步层：左侧栏改为抽屉，检查器改为详情页或底部抽屉，上传队列改为全屏列表。MVP 只保证 iPad 宽度下功能不溢出，不承诺完整的手机端操作效率。

### 4.5 视觉设计语言

采用“石墨靛蓝”设计语言：浅色模式以白色表面为主体，夜间模式以近黑色表面为主体，靛蓝只用于主操作和选择态。绿色、暗金和红色承担成功、独占/提醒和危险状态，但必须同时配合文字或图标。

- 支持 `跟随系统 | 浅色 | 夜间`，偏好随用户保存并用本地值防止首屏闪烁。
- 工作台保持紧凑、平静和内容优先；不使用渐变、装饰光斑、巨型标题或大面积品牌色。
- 普通控件圆角 4 px，面板和对话框最多 6 px；页面区块不用漂浮卡片包装。
- 图案缩略图不叠加主题色滤镜，透明素材使用中性棋盘格。
- 字距为 0，字号不随视口缩放；阴影只用于对话框、菜单和临时浮层。

完整 token、图表颜色和主题验收要求见商业授权扩展设计第 11 节；这些约束适用于整个应用，而不只适用于看板。

## 5. 文件工作流

### 5.1 上传流程

1. 用户选择或拖入文件；客户端先校验扩展名和 200 MB 上限。
2. 客户端生成 UUID，并在 Dexie 中创建乐观 `Pattern`，状态为 `draft`。
3. Web Worker 读取文件，计算内容哈希，同时尝试生成预览和缩略图。用户此时即可编辑名称和标签。
4. 客户端调用上传初始化 API。服务端验证会话和配额，创建 `UploadSession`、分配不可猜测的 OSS object key，并签发只允许写入该前缀的短期 STS 凭证。
5. `ali-oss` 执行分片上传。分片 checkpoint 持久化到 Dexie；STS 到期时自动刷新后继续。
6. 若生成了预览和缩略图，客户端把它们作为派生资产上传到同一图案前缀。
7. 客户端调用完成 API。服务端先用短事务锁定会话、认领完成载荷并切换为 `completing`，随后在事务外通过 OSS `HEAD` 和小范围读取核对对象存在性、大小、扩展名与 magic bytes，最后用第二个短事务重锁会话并创建资产记录、更新图案状态和写入 `ChangeLog`。这样 OSS 网络等待不会占用数据库事务或行锁；取消、过期和同载荷恢复仍能并发推进，终态重检可防止失败结果覆盖成功或复活已取消会话。
8. 成功后状态变为 `ready`；预览失败只影响预览状态，不阻止原文件进入可查询、可打标、可下载状态。

浏览器关闭后不能继续持有 `File` 对象，因此后台上传不会跨浏览器关闭继续。再次打开后，队列显示待恢复任务；用户重选同一文件，系统比较大小、文件名、lastModified 和内容哈希，通过后从 checkpoint 继续。校验不一致时不会复用旧分片。

### 5.2 状态机

```text
draft → hashing → uploading → processing → ready
          │          │            │
          └──────────┴────────────┴→ failed
                                      │
                              从失败阶段重新开始

ready → trashed → deleted
          └──恢复──→ ready
```

- `failed` 保存失败阶段和可读错误码，可重试或移入回收站。
- `trashed` 对普通图库查询不可见，但保留资产和标签关系。
- `deleted` 是同步所需的墓碑状态；OSS 实体删除成功后仍保留最小墓碑记录，防止离线旧数据复活。

### 5.3 取消与续传

- 上传中取消会停止后续分片并保留 checkpoint，用户可选择“稍后继续”或“放弃上传”。
- 放弃上传会调用 OSS abort multipart；即使调用失败，OSS 生命周期规则也会清理遗留分片。
- 上传初始化、刷新凭证和完成接口都使用 `operationId` 保证幂等。
- 客户端重试完成请求不会创建第二个 `Pattern` 或第二份资产记录。

### 5.4 下载

下载请求先到同源 API。服务端按当前用户验证 `Asset` 所有权，再生成短时效 OSS 签名 GET URL，并在签名参数中设置安全的 `Content-Disposition` 文件名。签名 URL 不写入数据库、不进入长期客户端缓存，过期后重新申请。

## 6. 预览管线

### 6.1 格式策略

| 格式 | MVP 预览方式 | 失败行为 |
| --- | --- | --- |
| JPG / PNG | `createImageBitmap` + `OffscreenCanvas` 缩放 | 占位图，可重新生成或上传手动预览 |
| PSD | Web Worker 中使用 `@webtoon/psd` 提取合成图 | 占位图；图层效果与 Photoshop 可能存在差异 |
| AI | 检查是否为 PDF-compatible，PDF.js 渲染第一页 | 非 PDF-compatible 文件显示占位图 |
| Procreate | 不解析 | 显示占位图，允许上传 JPG/PNG 手动预览 |

不支持的预览不等于不支持的文件：原文件仍可上传、命名、打标签、筛选和下载。

### 6.2 派生资产规则

- 大预览最长边为 2048 px；缩略图最长边为 512 px。
- 有透明通道时输出 PNG；不透明时优先输出 WebP。
- 输出统一为 sRGB，并移除不需要的元数据。
- 预览只是导航辅助，不作为颜色、印刷或源文件内容的权威表示。
- 单张解码保护上限为 100 MP，单次解析最长 30 秒；越界即终止 worker 并回退占位图。
- 不支持 `OffscreenCanvas` 的浏览器使用主线程 Canvas 降级路径，并分阶段让出事件循环以避免界面长时间冻结。
- 手动预览只接受 JPG/PNG，替换预览不会改变原文件。

## 7. 数据模型

所有主键使用 UUID。所有业务表带有 `createdAt`、`updatedAt`；时间由服务端写入。

### 7.1 `User`

- `id`
- `email`，全局唯一并规范化
- `displayName`
- `passwordHash`
- `role`：`admin | user`
- `status`：`active | disabled`
- `mustChangePassword`
- `themePreference`：`system | light | dark`
- `syncSeq`：该用户的原子递增同步序号

### 7.2 `Pattern`

- `id`, `ownerId`
- `name`, `originalFilename`
- `extension`, `detectedMimeType`, `sizeBytes`, `contentHash`
- `status`：`draft | hashing | uploading | processing | ready | failed | trashed | deleted`
- `previewStatus`：`pending | ready | unsupported | failed | manual`
- `isFavorite`
- `version`：服务端乐观并发版本，不是文件历史版本
- `commercialVersion`：授权集合的独立并发版本
- `lastErrorCode`
- `trashedAt`, `deletedAt`
- `changeSeq`

### 7.3 `Asset`

- `id`, `ownerId`, `patternId`
- `role`：`source | preview | thumbnail`
- `objectKey`, `originalFilename`, `detectedMimeType`, `sizeBytes`
- `width`, `height`，仅派生位图需要
- `contentHash`, `createdAt`

数据库约束保证每个未删除的图案恰好有一个 `source`，并且每种派生角色最多有一个当前资产。应用只保存 object key，不保存长期签名 URL。

### 7.4 `Tag` 与 `PatternTag`

`Tag`：

- `id`, `ownerId`, `name`, `normalizedName`, `colorToken`
- `deletedAt`, `changeSeq`
- `(ownerId, normalizedName)` 在未删除范围内唯一

`PatternTag`：

- `patternId`, `tagId`, `ownerId`
- `isActive`
- `version`, `changeSeq`

标签规则：

- 去除首尾空格后长度为 1–32 个字符。
- 同一用户下大小写不敏感唯一。
- 每个图案最多 20 个有效标签。
- 颜色只能从固定色板选择，保证跨主题可读性。
- 删除标签只移除标签及其关联，不删除图案。
- 关联使用可同步的活动状态而不是立即物理删除，以正确处理离线增删冲突。

### 7.5 `UploadSession`

- `id`, `ownerId`, `patternId`, `operationId`
- `sourceObjectKey`, `ossUploadId`
- `fileFingerprint`, `sizeBytes`
- `status`：`initialized | uploading | completing | completed | aborted | expired | failed`
- `expiresAt`, `lastErrorCode`

浏览器 checkpoint 是续传的主要依据；服务端会话用于授权、幂等和审计，不保存原文件内容。

### 7.6 `ChangeLog`

- `ownerId`, `seq`
- `operationId`，用户范围内唯一
- `entityType`, `entityId`, `operation`
- `payload`, `createdAt`

`(ownerId, seq)` 唯一。写业务数据和追加变更日志必须处于同一事务。除图案永久删除时清除该图案旧的商业变更载荷外，MVP 不主动裁剪日志，并保留全量快照接口，以便未来压缩日志或客户端游标失效时重建本地库。

### 7.7 `AuthorizationField` 与 `Authorization`

`AuthorizationField` 保存不可由普通用户修改的系统领域，以及用户可新增/归档的自定义领域。`Authorization` 直接关联一个 `Pattern`，保存普通单领域授权、领域独占或全局买断，以及客户名称、人民币价格、授权日期、备注和有效/作废状态。

一个图案可以有多条授权，不存在跨图案订单。只有 `ready` 图案允许商业写入；领域独占和全局买断在 PostgreSQL 事务中锁定图案并校验。除图案永久删除外，既有历史授权始终保留。图案进入回收站后授权只读并继续计入期间统计；永久删除时授权随图案一并删除，历史看板允许相应回退。详细字段、互斥规则、统计口径和错误码见[商业授权与数据看板设计](2026-10-08-melon-commercial-authorization-dashboard-design.md)。

## 8. 离线与同步

### 8.1 本地存储

Dexie 包含：

- `patterns`
- `assets`
- `tags`
- `patternTags`
- 图案记录内最近同步的商业授权摘要
- `outbox`
- `syncState`
- `uploadCheckpoints`

Cache Storage 只保存已访问的缩略图。系统不把原文件写入 IndexedDB、Cache Storage 或 Service Worker 缓存。缓存使用 LRU 清理；outbox 和同步游标永不因缩略图清理而丢失。用户主动退出登录时清除该账号的本地数据和缩略图。

### 8.2 离线能力

已经在该浏览器成功登录过的用户，在会话尚可本地识别时可以离线打开 App Shell，浏览缓存的图案元数据和缩略图，并进行标签创建、改名、颜色修改及图案标签增删。这些写操作先更新 Dexie，再进入 outbox。

离线时禁用新文件上传、原文件下载、手动预览上传、永久删除、密码操作、商业授权写入和看板刷新，并在界面中明确显示原因。最近同步的商业摘要可只读展示，但必须标记为可能过期。恢复网络后自动开始同步。

商业授权新增、编辑、作废和恢复不进入 outbox。金额、领域独占和全局买断必须由在线数据库事务处理，不能按客户端时钟离线合并。

### 8.3 同步协议

1. 每个本地写操作生成稳定 UUID `operationId`。
2. 客户端按本地顺序批量 `push` outbox；服务端以 `operationId` 幂等处理。
3. 每个被接受的变更在同一事务内获得新的用户级 `changeSeq`。
4. 客户端从 `lastSeq` 开始 `pull`，事务性地更新 Dexie，再推进游标。
5. 本机刚推送的操作也按服务端返回结果和后续 pull 统一收敛，不依赖客户端时间判断先后。

冲突规则：

- 名称、收藏、标签名称和颜色等标量字段，以服务端最后接受的合法写入为准。
- 每个 `(patternId, tagId)` 关联独立解决；最后被服务端接受的 add/remove 操作为准，不覆盖其他标签关系。
- 两台设备离线创建同名标签时，服务端保留先创建的规范标签，并在 push 响应中返回 `idRemap`；客户端在一个 Dexie 事务中把临时标签 ID、关联和待发送操作改写为规范 ID。
- 标签改名若与现有名称冲突，服务端返回 `TAG_NAME_CONFLICT`。该 outbox 项转为“需要处理”而不是无限重试，客户端恢复服务端值并提示用户选择新名称。
- 多设备并发添加导致单个图案超过 20 个标签时，服务端按接收顺序接受到上限，超出的操作返回 `TAG_LIMIT_EXCEEDED`，客户端回滚对应本地关联并提示用户。
- `trashed` 或 `deleted` 优先于普通字段修改。必须先执行显式恢复，之后才能接受新的元数据修改。
- 已永久删除的对象不能被离线旧操作复活；客户端丢弃对应过期操作并展示可读提示。
- 客户端时钟不参与冲突排序。

## 9. API 与模块边界

API 通过 Next.js Route Handlers 提供，全部执行会话校验、Zod 输入校验和 `ownerId` 过滤。主要端点分组：

- `/api/patterns`：分页查询、创建占位记录、更新元数据、收藏、移入回收站和恢复。
- `/api/tags`：标签查询、创建、改名、改色和删除。
- `/api/patterns/:id/authorizations`：读取和新增当前图案的授权记录。
- `/api/authorizations/:id`：编辑授权；子操作负责作废和恢复。
- `/api/authorization-fields`：读取系统领域，创建或归档用户自定义领域。
- `/api/dashboard/authorizations`：按时间、领域和类型聚合授权看板。
- `/api/uploads/init`：校验文件声明、配额和格式，创建会话并签发 STS。
- `/api/uploads/:id/credentials`：刷新当前上传会话的短期 STS。
- `/api/uploads/:id/complete`：验证 OSS 对象并幂等完成。
- `/api/uploads/:id/cancel`：取消会话和尝试 abort multipart。
- `/api/patterns/:id/manual-preview`：创建手动预览上传会话。
- `/api/assets/:id/download`：授权后返回短期签名下载地址或重定向。
- `/api/sync/push` 与 `/api/sync/pull`：离线变更提交和增量拉取。
- `/api/sync/snapshot`：本地数据库重建。

模块按领域组织为 `auth`、`patterns`、`tags`、`authorizations`、`analytics`、`uploads`、`preview`、`sync` 和 `storage`。Route Handler 只做传输适配，业务规则放在可直接进行集成测试的服务模块中。

## 10. 安全设计

### 10.1 身份与会话

- 密码使用 Argon2id，参数在部署基准测试后固定并版本化。
- 会话 Cookie 使用 `HttpOnly`、`Secure` 和 `SameSite=Lax`。
- 登录同时执行 Nginx IP 速率限制和应用层账号失败次数退避；错误消息不暴露账号是否存在。
- 首次登录强制改密；管理员重置密码后使现有会话失效。
- 所有改变状态的请求只接受同源请求，并使用 Auth.js 提供的 CSRF/会话机制。

### 10.2 OSS

- Bucket 为私有，启用服务端加密。
- 长期 AccessKey 只存在服务端环境变量或实例角色中，绝不进入浏览器 bundle。
- STS 权限只允许当前用户、当前图案的指定 object key 前缀和所需上传动作，凭证短期有效并可刷新。
- object key 使用用户 ID、图案 UUID 和资产 UUID，不包含原始文件名或邮箱。
- CORS 只允许正式站点的精确 origin、实际需要的 `PUT/POST/DELETE/GET/HEAD` 方法和有限请求头；不使用 `*` origin。
- 下载一律由服务端鉴权后签发短时 URL；URL 不持久化。

建议对象结构：

```text
users/{userId}/patterns/{patternId}/source/{assetId}.{ext}
users/{userId}/patterns/{patternId}/derived/{assetId}.{ext}
```

`source` 的扩展名仅允许 `psd|ai|pdf|jpg|jpeg|png|procreate`；`derived` 仅允许 `jpg|jpeg|png|webp`。WebP 只用于派生预览或缩略图，不得声明为源文件。

### 10.3 文件校验与租户隔离

- 客户端校验只用于快速反馈；服务端在完成上传时使用 OSS `HEAD` 和 Range 读取再次验证大小、扩展名与 magic bytes。
- 允许的源文件签名包括 JPEG、PNG、PSD `8BPS`、PDF/PostScript AI，以及 Procreate 的 ZIP 容器签名；派生文件另允许 `RIFF....WEBP`。不信任浏览器上报的 MIME。
- 超过 200 MB、扩展名不在白名单或签名不匹配的对象不能完成入库，并进入清理队列。
- 每个查询和写入都必须包含从会话获得的 `ownerId`。客户端传入的 owner ID 被忽略。
- 数据库索引以 `ownerId` 为前导列；对象路径隔离只是第二道防线，不能替代 API 授权。
- 内容安全策略、`X-Content-Type-Options: nosniff`、严格 Referrer Policy 和 HTTPS 在 Nginx/Next.js 层统一配置。
- IndexedDB 和 Cache Storage 不做应用层加密；离线能力信任本机操作系统账号和浏览器配置文件的访问控制。共享设备上的用户应主动退出，退出操作会清除该账号的本地缓存。

## 11. 错误恢复

| 场景 | 用户行为与系统处理 |
| --- | --- |
| 上传时断网 | 暂停任务并保存 checkpoint；联网后继续，必要时刷新 STS |
| 浏览器关闭 | 下次打开显示待恢复；用户重选同一文件并通过指纹/哈希校验后续传 |
| STS 过期 | 静默刷新当前会话凭证，保留已完成分片 |
| 预览解析超时或崩溃 | 终止 worker，原文件继续上传，显示占位图和手动预览入口 |
| 完成请求超时 | 使用相同 `operationId` 重试；服务端返回既有完成结果 |
| OSS 对象信息不符 | 不入库为 ready，保留可诊断错误并允许重新上传 |
| 会话过期 | 本地修改留在 outbox；重新登录后继续同步 |
| 多设备冲突 | 依据服务端 sequence 和字段/标签规则收敛，并刷新当前视图 |
| 浏览器存储不足 | 上传前调用 Storage Estimate；清理可淘汰缩略图并提示用户，不删除 outbox |
| 离线操作命中已删除对象 | 丢弃无效操作，保留墓碑并展示一次性冲突提示 |

错误码采用稳定机器码和本地化消息分离，例如 `UPLOAD_FILE_TOO_LARGE`、`PREVIEW_UNSUPPORTED`、`SYNC_ENTITY_DELETED`。日志记录 request ID、用户 ID、上传会话 ID 和 OSS request ID，但不记录密码、STS 密钥、签名 URL 或文件内容。

## 12. 部署与数据生命周期

- Next.js 使用 standalone 构建产物封装 Docker 镜像，由 Nginx 终止 TLS 和反向代理。
- PostgreSQL 使用阿里云 RDS，开启自动备份和时间点恢复。
- OSS 与应用部署在同一区域，Bucket 私有且启用服务端加密。
- 数据库迁移作为独立部署步骤执行；应用启动时不自动进行破坏性迁移。
- 回收站图案保留 30 天。进入回收站前显示有效授权数量、金额和到期日期；保留期内授权仍计入历史期间统计，但图案不计入当前图库状态。
- 用户确认永久删除或保留期到期后，清理任务先删除 OSS 资产，再删除该图案全部授权，并把数据库记录压缩为不含商业数据的同步墓碑。历史看板允许因此回退；任务可幂等重试。
- OSS 生命周期规则清理 7 天以上未完成的 multipart upload，以及未被数据库引用的临时派生对象。
- 健康检查分为进程存活和依赖就绪；结构化日志至少覆盖登录、上传初始化/完成、下载签名、同步失败和清理任务。
- MVP 可从单个应用实例起步；若未来横向扩容，登录限流、定时任务锁和缓存协调再迁移到共享基础设施。

## 13. 测试策略

### 13.1 自动化测试

- Vitest：文件签名、大小限制、标签规范化、人民币金额转换、商业状态、统计口径、状态机、冲突合并、outbox 重放、object key 和下载文件名安全。
- Testing Library：筛选工具栏、选择模型、检查器编辑、授权表单、看板空状态、主题切换、上传队列、离线状态和错误提示。
- PostgreSQL 集成测试：租户隔离、唯一约束、授权互斥与并发、看板聚合、图案永久删除级联、事务性 `changeSeq`、幂等 operation、回收/恢复和游标分页。
- OSS 集成测试：使用隔离测试 Bucket 验证 STS 最小权限、multipart 续传、完成校验、签名下载和清理；测试后按前缀回收对象。
- Playwright：Chromium 与 WebKit 上覆盖 Mac 桌面视口和 iPad 宽度，验证上传、预览、标签、筛选、下载、离线重载和恢复同步。

测试样本包含：透明 PNG、普通 JPG、小型 PSD、复杂 PSD、PDF-compatible AI、非兼容 AI、Procreate、损坏文件、扩展名与 magic 不匹配文件，以及边界大小文件。仓库只保存有授权或程序生成的小型 fixture；大文件在测试时生成稀疏/合成数据。

### 13.2 MVP 验收标准

1. 使用 10,000 条种子图案时，查询采用游标分页，图库滚动期间 DOM 节点数量保持有界，选择和筛选无明显冻结。
2. 100 MB 文件可显示真实分片进度，可取消；模拟断网或刷新后，重选同一文件可从有效 checkpoint 继续。
3. JPG/PNG 能生成正确方向和透明度的派生图；PSD、兼容 AI 按设计生成预览；Procreate 和不兼容 AI 显示明确占位图且不影响管理和下载。
4. 断网后重新加载仍可浏览已缓存元数据/缩略图，标签修改在恢复网络后同步且刷新页面不丢失。
5. 任意用户都无法通过猜测 ID、修改 API 参数、复用签名 URL 或 STS 权限读取/写入其他用户的数据。
6. 上传完成接口和同步 push 在重复提交下不产生重复记录。
7. 移入回收站的图案从普通查询和当前图库状态中消失，可在 30 天内连同授权一起恢复；永久删除会移除其授权并使历史看板相应回退，且离线客户端不能使其复活。
8. 浏览器 bundle、日志和数据库中不存在长期 OSS 密钥；数据库不保存长期签名 URL。
9. 普通授权、领域独占和全局买断按确认规则工作，作废记录不参与收入或商业状态统计。
10. 10,000 张图案和 100,000 条授权记录下，看板查询有索引支持，收入趋势、领域排行和图案排行口径正确。
11. 整个应用提供白色主体的浅色模式和近黑主体的夜间模式，关键文字与控件达到 WCAG AA 对比度。

## 14. 实施阶段边界

书面设计通过后再生成逐任务实施计划。实现顺序应保持以下依赖关系：先建立鉴权、数据模型和租户隔离，再完成 OSS 直传与基础图库；基础图库稳定后可独立交付商业授权、图库商业筛选与数据看板；随后加入格式预览、离线同步，最后完成安全加固、回收清理和跨浏览器验收。

本设计没有把未来移动端适配、协作、AI 能力或源文件版本管理混入 MVP。它们可以复用现有 `Pattern`、`Asset` 和同步边界，但必须另行设计和评审。

## 15. 参考资料

- [Next.js Progressive Web Apps 指南](https://nextjs.org/docs/app/guides/progressive-web-apps)
- [Next.js Single-Page Applications 指南](https://nextjs.org/docs/app/guides/single-page-applications)
- [Next.js 自托管指南](https://nextjs.org/docs/app/guides/self-hosting)
- [Next.js Route Handlers](https://nextjs.org/docs/app/getting-started/route-handlers)
- [阿里云 OSS Browser.js SDK](https://www.alibabacloud.com/help/en/oss/developer-reference/browser-js/)
- [阿里云 OSS 浏览器访问授权](https://www.alibabacloud.com/help/en/oss/developer-reference/authorize-access-6)
- [阿里云 OSS 客户端直传](https://www.alibabacloud.com/help/en/oss/user-guide/uploading-objects-to-oss-directly-from-clients/)
- [`@webtoon/psd`](https://github.com/webtoon/psd)
- [PDF.js](https://mozilla.github.io/pdf.js/getting_started/)
- [Auth.js Credentials Provider](https://authjs.dev/getting-started/providers/credentials)
