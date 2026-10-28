# Melon 灵感调研视觉情报板设计

- 日期：2026-10-29
- 状态：已通过会话确认，待文档复核
- 依赖：现有灵感调研、图案库、色卡搜索、阿里云百炼和 OSS
- 目标设备：桌面与 MacBook 14 英寸优先

## 1. 背景与目标

现有灵感调研已经能输出可追溯的市场信号、款式、类型、风格、品类、色彩、材质、参考款和设计推演，但页面仍以长文本为主。它能够阅读，却不像设计师会持续使用的视觉调研工作台。

本次改造把结果页升级为“视觉情报板”：在不破坏现有文字研究和来源可信度的前提下，组合三类视觉素材。

1. 公开网络趋势图和商品图，作为研究证据。
2. 用户图案库中的关联图片，作为内部灵感。
3. 用户主动触发的 AI 概念图，作为设计方向预览。

成功标准：

- 报告首屏先传达视觉结论，再提供文字解释和来源。
- 文字研究先完成；任何图片能力失败都不能使报告失败。
- 每张网络图都能追溯到原始页面，并与库内图片、AI 图片明确区分。
- 旧报告可以按需补图，不要求批量迁移或重新生成文字内容。
- AI 概念图按设计方向独立生成，不阻塞报告浏览。
- 页面在 `1512 x 982` 和 `1280 x 800` 下保持稳定、可扫描且无横向溢出。

## 2. 已确认的产品决策

- 页面结构采用 B 方案“视觉情报板”，不采用纯长文报告或自由画布。
- 视觉内容同时包含网络证据图、库内关联图和 AI 概念图。
- AI 概念图只按需生成，不随每次调研自动付费生成。
- 旧报告显示“补充视觉素材”，由用户主动触发。
- 新报告的文字结果先返回，视觉增强随后独立进行。
- 历史记录从常驻左栏改为抽屉，释放报告宽度。
- 大输入框不再常驻；使用“新建调研”打开专注输入面板。
- 分享页可以展示已经完成的网络证据图和 AI 概念图，并保留来源与类型标记；私有库内关联不进入公开分享。
- 网络视觉检索和概念图生成使用独立功能开关，可分别降级；库内关联继续受现有色卡搜索开关控制。

## 3. 范围与非目标

### 3.1 本次范围

- 重构登录态灵感调研页面的信息架构和视觉层级。
- 新增视觉任务和视觉资产持久化模型。
- 接入阿里云百炼联网检索 Agent 的图文并茂输出。
- 使用现有色卡搜索能力匹配用户图案库。
- 接入 Qwen-Image，为单个设计方向按需生成概念图。
- 把生成图及时转存到现有私有 OSS。
- 支持旧报告补图、视觉刷新、失败重试、分享和级联删除。
- 对外部图片导入、租户隔离、幂等、超时和部分失败增加测试。

### 3.2 非目标

- 不把灵感调研改造成可自由拖拽、缩放和连线的无限画布。
- 不自动为所有历史报告批量付费补图。
- 不抓取或保存来源网页正文。
- 不把网络证据图直接保存为用户图案；它只能打开原始来源。
- 不自动连续生成多张概念图；每次用户操作最多生成一张。
- 不在本次实现多人协作、批注、版本分支或 PDF 导出。
- 不以 AI 概念图替代市场证据，也不把设计推演描述为市场事实。

## 4. 页面与交互设计

### 4.1 工作区结构

```text
灵感调研                         [历史] [新建调研]
──────────────────────────────────────────────
报告标题
完成日期 · 公开来源数 · 视觉素材数      [重命名] [分享] [删除]

视觉摘要
┌────────────────────┬──────────┬──────────┐
│ 主趋势证据图        │ 网络证据图 │ 关键色板  │
│                    ├──────────┼──────────┤
│                    │ 库内关联图 │ 材质参考图 │
└────────────────────┴──────────┴──────────┘
核心结论 · 可信度说明 · 3 至 5 个关键色

市场信号
款式 / 风格 / 品类 / 色彩 / 材质

设计方向
参考图 · 廓形 · 配色 · 材质 · 细节      [生成概念图]

库内关联图案
完整研究来源
```

页面继续使用全局 `Gallery White` 设计系统：中性画布、衬线页面标题、紧凑工具控件和 Acid Lime 关键状态。图片承担第一视觉层级，页面区块通过留白、分隔线和排版组织，不制造多层嵌套卡片。

### 4.2 新建与历史

- 空页面直接展示研究输入面板。
- 已打开报告时，页头只显示“新建调研”按钮；点击后打开专注面板。
- 历史记录使用右侧或左侧抽屉，支持当前状态、日期和选择，不永久占据报告列宽。
- 新报告创建成功后立即进入文字报告；视觉任务在独立区域显示加载状态。
- 抽屉、输入面板和大图预览使用 Radix Dialog，保留焦点管理、Esc 关闭和可访问名称。

### 4.3 视觉摘要

- 首屏最多展示 6 张网络证据图和库内关联图，使用稳定纵横比网格。
- 图片角标固定显示“网络证据”或“库内关联”，不能只靠颜色区分。
- 网络图点击后打开大图预览，显示标题、查询词、来源站点和“打开原始页面”。
- 库内图点击后打开对应图案检查器或图库详情。
- 色卡沿用现有可访问色块，显示色名与十六进制提示。
- 视觉资产不足时重排现有图片，不保留空卡槽。

### 4.4 设计方向与概念图

每个 `inspirationPrompt` 是一个独立方向，展示：

- 标题与方向说明。
- 廓形、配色、材质和细节。
- 与该方向最接近的库内图案。
- 已完成的概念图，最多 3 张。
- “生成概念图”按钮与单方向加载、失败、重试状态。

生成按钮默认一次创建一张图。某方向已有 3 张成功图片后禁用继续生成，并解释数量上限。生成过程不锁定其他方向，也不影响报告重命名、分享或浏览。

### 4.5 分享页

公开分享页沿用视觉情报板的只读阅读顺序，只展示完成资产：

- 网络图保留来源标题、站点和原始页面链接。
- 库内关联图默认不进入公开分享，避免无额外授权时公开用户私有图案；分享页不暴露 owner ID、对象键或内部资产 ID。
- AI 图固定显示“AI 生成”标记。
- 待处理、失败和内部错误信息不进入公开 DTO。
- 撤销分享后，所有分享态图片地址随页面一起失效。

## 5. 总体架构

现有文字研究仍是唯一核心结果，视觉增强是独立附属域。

```text
现有文字研究 completed
        │
        ├── POST /visuals + operationId
        │       │
        │       ├── 联网检索 Agent：返回图片元数据与来源
        │       ├── 安全图片导入：校验、缓存、OSS
        │       └── 色卡搜索：匹配当前 owner 的库内图案
        │
        └── POST /concepts + operationId + directionIndex
                │
                ├── Qwen-Image 创建任务
                ├── 客户端轮询应用 API
                ├── 应用查询百炼任务状态
                └── 成功后立即下载并转存私有 OSS
```

`src/features/inspiration-visuals` 作为独立功能域，负责 contract、repository、service、provider adapter、远程图片导入和 API DTO。原有 `src/features/inspiration` 继续拥有文字结果和报告生命周期，不直接依赖具体图片供应商。

UI 可以组合两个 feature 的 DTO，但 provider、OSS 对象键和百炼任务 ID 不进入浏览器。

## 6. 数据模型

### 6.1 视觉任务

新增 enum：

```ts
type InspirationVisualJobKind = "research_visuals" | "concept_image";
type InspirationVisualJobStatus = "pending" | "completed" | "failed";
```

新增 `inspiration_visual_jobs`：

- `id UUID PRIMARY KEY`
- `owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE`
- `analysis_id UUID NOT NULL REFERENCES inspiration_analyses(id) ON DELETE CASCADE`
- `operation_id UUID NOT NULL`
- `kind inspiration_visual_job_kind NOT NULL`
- `direction_index INTEGER`
- `status inspiration_visual_job_status NOT NULL`
- `provider_task_id TEXT`
- `provider_request_id TEXT`
- `error_code TEXT`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- `completed_at TIMESTAMPTZ`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`

约束：

- 唯一 `(owner_id, operation_id)`，重复提交返回已有任务，不重复付费；若同一 operation ID 被用于不同 kind 或方向，返回输入冲突而不是复用错误任务。
- 部分唯一索引 `(analysis_id, kind, coalesce(direction_index, -1)) WHERE status = 'pending'`，确保同一分析同一目标最多一个 pending，并正确覆盖 `research_visuals` 的空方向。
- `research_visuals` 的 `direction_index` 必须为空。
- `concept_image` 的 `direction_index` 必须指向现有不可变文字结果中的方向。
- `completed` 必须有 `completed_at` 且没有 `error_code`。
- `failed` 必须有稳定 `error_code`。
- `provider_task_id` 和 `provider_request_id` 仅服务端可读。

新视觉刷新成功后，UI 使用最新完成的 `research_visuals` 任务；刷新期间继续展示上一次完成资产。失败刷新不删除旧资产。

### 6.2 视觉资产

新增 enum：

```ts
type InspirationVisualAssetKind =
  | "web_evidence"
  | "library_match"
  | "generated_concept";
```

新增 `inspiration_visual_assets`：

- `id UUID PRIMARY KEY`
- `owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE`
- `analysis_id UUID NOT NULL REFERENCES inspiration_analyses(id) ON DELETE CASCADE`
- `job_id UUID NOT NULL REFERENCES inspiration_visual_jobs(id) ON DELETE CASCADE`
- `kind inspiration_visual_asset_kind NOT NULL`
- `ordinal INTEGER NOT NULL`
- `direction_index INTEGER`
- `title TEXT NOT NULL`
- `alt_text TEXT NOT NULL`
- `source_page_url TEXT`
- `source_site_name TEXT`
- `source_query TEXT`
- `pattern_id UUID REFERENCES patterns(id) ON DELETE CASCADE`
- `saved_pattern_id UUID REFERENCES patterns(id) ON DELETE SET NULL`
- `save_operation_id UUID`
- `object_key TEXT`
- `content_type TEXT`
- `width INTEGER`
- `height INTEGER`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`

资产约束：

- `web_evidence` 必须有来源页面、来源站点和缓存对象键，不得有 `pattern_id`。
- `library_match` 必须有当前 owner 可读的 `pattern_id`，不得有外部对象键。
- `generated_concept` 必须有 OSS 对象键和方向索引。
- 只有 `generated_concept` 可以设置 `saved_pattern_id` 和 `save_operation_id`；同一 owner 的非空 `save_operation_id` 唯一，网络重试不得创建重复图案。
- 所有 URL、标题、替代文本和查询词都有明确长度上限。
- 同一 job 的 `(kind, ordinal)` 唯一，保证稳定排序。

旧报告无需改写 `inspiration-analysis-v1`。没有视觉任务就是合法状态，点击补图后才产生新记录。

## 7. 网络证据图

### 7.1 Provider

使用阿里云百炼联网检索 Agent 的流式接口，并开启 `enable_text_image_mixed`。服务端只解析 `additional_kwargs.data_type = "image"` 和 `data_json` 中的结构化字段：

- 图片 URL
- 原始页面 URL
- 标题
- 查询词
- 图片宽高

不把模型返回的 HTML 注入 React，不使用 `dangerouslySetInnerHTML`。正文中的 `<img>` 只作为上游表现形式，应用合同以 `data_json` 为准。

一次视觉增强只调用一次 Agent，并请求 6 至 8 张能代表报告整体方向的图片。第一版不把网络图强行分类到每个文字小节，避免多次付费检索和不可靠的语义归位；它们统一组成首屏证据拼图。

新增服务端配置：

- `INSPIRATION_WEB_VISUALS_ENABLED`
- `DASHSCOPE_WEB_SEARCH_AGENT_ID`
- `DASHSCOPE_WEB_SEARCH_AGENT_VERSION`
- `INSPIRATION_VISUAL_MAX_IMAGES`，默认 8，限制 4 至 12

功能关闭或配置不完整时，网络图阶段返回非致命 disabled 状态；同一研究视觉任务仍可完成库内匹配，文字研究和库内浏览不受影响。

### 7.2 安全导入

网络图片先由服务端导入受控缓存，再通过应用资源路由展示。导入器必须：

- 只接受无用户名、密码和片段的 HTTPS URL。
- 每次 DNS 解析和重定向都拒绝 loopback、link-local、私网、保留地址和非 IP 主机异常。
- 使用受控连接解析结果，避免“预检查一次、实际连接再次解析”的 DNS rebinding 窗口。
- 最多跟随 3 次重定向，每次重新验证目标。
- 限制响应头、总字节、读取时间和空闲时间。
- 只允许 JPEG、PNG、WebP 和 GIF；同时校验 MIME 与文件魔数。
- 拒绝 SVG、HTML、脚本、多部分响应和未知类型。
- 单张最大 8 MiB，超限图片跳过，不使整个任务失败。
- 不记录完整远程 URL 查询串、响应正文或鉴权头。

合格图片写入私有 OSS 的研究缓存前缀，数据库只保存对象键。外部缓存使用独立生命周期策略，默认 30 天；元数据和来源链接长期保留。缓存失效时页面显示来源占位并允许用户刷新视觉素材，不偷偷替换为无关图片。

网络证据图不能保存为图案库素材，避免把第三方图片误当作用户资产。

## 8. 库内关联图

库内匹配不调用外部模型。服务从报告的 `dimensions.colors[].colorHint` 和每个设计方向的 palette 中提取有效颜色，调用现有配色色卡搜索能力，在当前 owner 范围内返回图案。

规则：

- 只使用合法 `#RRGGBB` 色值；中文色名没有色值时不猜测 RGB。
- 总览最多 8 个图案，每个方向最多关联 3 个。
- 相同图案在总览中去重，按现有色卡距离排序。
- 没有可搜索色值、索引未完成或结果为空时返回空列表，不使视觉任务失败。
- DTO 只返回已有图库可公开的缩略图和展示字段，不暴露搜索分数、特征或对象键。
- 图案被移入回收站或永久删除后，关联图自动隐藏；视觉任务记录本身不失败。

## 9. AI 概念图

### 9.1 请求与任务

概念图使用 Qwen-Image 的异步任务接口。新增配置：

- `INSPIRATION_CONCEPT_IMAGES_ENABLED`
- `INSPIRATION_IMAGE_MODEL`，默认 `qwen-image-3.0`
- `INSPIRATION_IMAGE_SIZE`，默认 `3:4`

生成提示词由服务端固定模板和已经校验的结构化方向组成：标题、方向、廓形、配色、材质和细节。原始网页正文、外部图片 HTML 和任意隐藏字段不进入提示词。模板要求原创服装概念、无品牌标志、无可识别名人、无界面文字，并始终带产品内“AI 生成”标识。

`POST` 创建应用任务和百炼任务后立即返回 pending DTO。客户端按退避间隔轮询应用接口；应用服务查询百炼状态。任务超过最终时限后标记失败，用户可显式重试。

同一方向：

- 最多一个 pending 任务。
- 最多保留 3 张成功概念图。
- operation ID 重复时返回原任务，不再次计费。
- 失败任务不占 3 张上限。

### 9.2 结果持久化

百炼生成 URL 最多保留 24 小时。服务发现任务成功后必须在同一次完成流程中：

1. 安全读取百炼结果 URL。
2. 校验 PNG/JPEG/WebP、尺寸和大小。
3. 写入 `users/{ownerId}/inspiration/{analysisId}/concepts/{assetId}.png`。
4. 提交资产记录。
5. 条件更新任务为 completed。

任何一步失败都不能把临时 URL存入公开 DTO。数据库提交失败时清理刚写入的孤立对象；OSS 删除失败进入现有运维清理边界。

“保存到图库”是概念图的显式后续操作：服务端从已拥有的概念图创建正常图案和资产副本，成功后两份资产生命周期独立。删除原调研不能删除已保存到图库的图案。

## 10. API 契约

所有管理接口要求登录，并从会话获取 owner。

### 10.1 研究视觉

- `GET /api/inspiration-analyses/[analysisId]/visuals`
- `POST /api/inspiration-analyses/[analysisId]/visuals`

POST 输入：

```json
{ "operationId": "00000000-0000-4000-8000-000000000000" }
```

只允许对当前 owner 的 completed 分析执行。POST 先创建 pending 任务，再在同一请求中执行网络检索和库内匹配；调用方保持连接时最终返回 completed 或 failed。GET 只会在并发读取、请求中断或恢复场景中观察到 pending。重复 operation ID 返回原任务。

如果网络图片和库内匹配至少一类成功，则任务可以 completed；DTO 同时返回非致命提示。两类都没有可展示资产才进入 failed。刷新期间 GET 继续返回上一次 completed 资产和单独的 refresh status。

### 10.2 概念图

- `POST /api/inspiration-analyses/[analysisId]/concepts`
- `GET /api/inspiration-analyses/[analysisId]/concepts/[jobId]`
- `POST /api/inspiration-analyses/[analysisId]/concepts/[assetId]/save-to-library`

POST 输入：

```json
{
  "operationId": "00000000-0000-4000-8000-000000000000",
  "directionIndex": 0
}
```

GET 查询时由服务端推进百炼 pending 任务。不存在和跨 owner 的 analysis/job 统一返回 404。

保存到图库接口接收 operation ID 和可选标题，只允许当前 owner 的 completed `generated_concept`。服务端复制概念图到正常 pattern 对象前缀、创建图案与资产记录，再条件写入 `saved_pattern_id`。重复 operation ID 或重复保存同一概念图返回已有 pattern，不创建副本。

### 10.3 图片资源

登录态和分享态使用应用控制的图片资源路由。路由只接受数据库中存在的 opaque asset ID，不接受任意 URL 或对象键参数。服务端验证 owner 或有效 share ID 后读取私有 OSS，并返回：

- 正确 `Content-Type`
- `Content-Security-Policy: sandbox`
- `X-Content-Type-Options: nosniff`
- 私有或短期缓存头

资源路由不重定向到长期 OSS URL，不泄露 bucket、对象键或签名参数。

## 11. 状态、失败与恢复

稳定错误码至少包括：

- `INSPIRATION_WEB_VISUALS_DISABLED`
- `INSPIRATION_VISUALS_BUSY`
- `INSPIRATION_VISUALS_UNAVAILABLE`
- `INSPIRATION_VISUALS_EMPTY`
- `INSPIRATION_VISUALS_INTERRUPTED`
- `INSPIRATION_CONCEPT_DISABLED`
- `INSPIRATION_CONCEPT_LIMIT_REACHED`
- `INSPIRATION_CONCEPT_BUSY`
- `INSPIRATION_CONCEPT_REJECTED`
- `INSPIRATION_CONCEPT_TIMEOUT`
- `INSPIRATION_CONCEPT_UNAVAILABLE`

错误策略：

- 网络图失败、库内图成功：任务完成，UI 显示库内结果和可重试提示。
- 网络图成功、库内图为空：任务完成，UI 不显示空库内区块。
- 两类都失败或为空：任务失败，保留原文字报告和重试按钮。
- 概念图失败：只影响当前方向，不影响其他方向和分享。
- 进程中断留下 pending：读取时把超过阈值的研究视觉任务标记 interrupted；概念任务在百炼有效期内继续查询，超过有效期后失败。
- 重试创建新 job，不修改历史失败记录；审计和幂等仍可追溯。

## 12. 删除、分享与生命周期

- 删除分析通过外键级联删除视觉任务和视觉资产记录。
- 删除服务在数据库事务外清理该分析的研究缓存和概念图 OSS 前缀；失败对象由运维清理任务补偿。
- 重新生成视觉摘要时，新结果成功后再切换可见 job，随后清理被替代的网络缓存。
- 图案库关联只保存 pattern 引用，不复制图案对象。
- 已保存到图库的概念图形成独立 pattern，不参与分析级联删除。
- 撤销分享不删除资产，但分享资源路由立即拒绝旧 share ID。
- 外部网络缓存遵循 OSS 生命周期；概念图在分析存在期间持久保存。

## 13. 配置与发布

新增环境变量只在对应功能开启时必填。生产就绪检查分别验证：

- Agent ID、版本、业务空间、API Key 和地域 endpoint 一致。
- 图片模型在允许列表中。
- OSS bucket 与资源路由可用。
- 网络缓存生命周期规则已配置。

建议发布顺序：

1. 上线数据库、DTO、空状态和新页面结构，两个视觉开关保持关闭。
2. 开启库内关联和本地/测试环境的网络视觉检索。
3. 完成真实 Agent 冒烟后，面向私有邀请用户开启网络视觉检索。
4. 完成 Qwen-Image 与 OSS 转存冒烟后，再开启概念图生成。

任一开关关闭时，界面隐藏不可用的主操作，并在设置或运维检查中给出明确状态，不显示无法完成的按钮。

## 14. 测试与验收

### 14.1 Contract 与 provider

- Agent SSE 分片、图片 `data_json`、空图片、畸形字段、超限字段和未知消息类型。
- 不解析或渲染上游 HTML。
- Qwen-Image 创建、pending、success、failed、unknown、过期和超限响应。
- Provider 错误和日志不包含 API Key、完整临时 URL 或原始响应正文。

### 14.2 安全导入与存储

- HTTPS、凭证 URL、重定向链、DNS rebinding、IPv4/IPv6 私网和保留地址。
- 超时、超长响应头、8 MiB 上限、伪造 MIME、HTML、SVG、截断图片和未知魔数。
- OSS 写入后数据库失败的补偿删除。
- 资源路由的 owner、share ID、撤销分享、跨租户和无效 asset ID。

### 14.3 Repository 与 service

- operation ID 幂等和并发 pending 约束。
- 研究视觉部分成功、全失败、刷新期间保留旧结果和失败刷新不覆盖。
- 方向索引验证、每方向一个 pending、最多 3 张成功图片。
- 陈旧任务恢复、百炼任务过期、分析级联删除和图库保存后的生命周期独立。
- 库内匹配仅访问当前 owner，回收站和删除图案自动隐藏。

### 14.4 UI 与 E2E

- 空报告、新报告、旧报告补图、视觉加载、部分成功、失败和重试。
- 网络图大图与来源、库内图进入详情、AI 图生成与保存到图库。
- 历史抽屉、新建调研面板、分享页和删除确认。
- 键盘焦点、Esc、可访问名称、图片替代文本和非颜色状态表达。
- `1512 x 982`、`1280 x 800`、平板和手机截图回归。
- 图片固定比例、最长中文标题、3 张概念图、空来源和深色模式无溢出或遮挡。

常规测试使用 fake provider 和内存/测试 OSS，不访问百炼、不产生费用。真实 Agent 和 Qwen-Image 冒烟必须显式开启，默认测试套件跳过，并限制为一次已知查询或一次图片生成。

### 14.5 完成标准

1. 新报告文字先可用，随后出现网络图与库内关联图。
2. 旧报告点击一次即可补充视觉素材，重复提交不产生重复任务。
3. 每张网络图都有清晰来源，不能被误认为用户上传或 AI 生成。
4. 任一设计方向可以生成一张概念图，刷新后仍存在。
5. 生成图能显式保存到图库；删除报告后图库副本仍存在。
6. 分享页只展示完成的网络证据图和 AI 概念图；私有库内关联不进入公开分享，撤销后图片资源立即失效。
7. 外部图片和 provider 临时 URL 不直接暴露给浏览器。
8. 完整单元、集成、E2E、类型检查、lint 和生产构建通过。

## 15. 官方能力依据

- 联网检索 Agent 产品与图文并茂能力：<https://help.aliyun.com/zh/model-studio/web-search-agent-guide>
- 联网检索 Agent API 与图片消息协议：<https://help.aliyun.com/zh/model-studio/web-search-agent-api-chat>
- Qwen-Image 生成与编辑 API：<https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference>
- Qwen-Image 同步 API 与 24 小时结果 URL：<https://help.aliyun.com/zh/model-studio/qwen-image-api>
- 图像生成生产建议：<https://help.aliyun.com/zh/model-studio/text-to-image>

截至 2026-10-29，官方文档确认：联网检索 Agent 可通过 `enable_text_image_mixed` 返回图片、来源页面、标题和尺寸；Qwen-Image 支持生成任务，但任务和结果 URL 只保留有限时间，因此生产系统必须把完成图片及时转存到自己的持久化存储。
