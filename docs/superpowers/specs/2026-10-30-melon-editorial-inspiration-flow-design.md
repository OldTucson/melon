# Melon 灵感调研编辑式图文流设计

- 日期：2026-10-30
- 状态：已确认，待实施计划
- 目标设备：桌面与 MacBook 14 英寸优先
- 依赖：现有灵感调研、视觉任务、素材库配色匹配、阿里云百炼联网检索 Agent、私有 OSS
- 取代范围：取代 `2026-10-29-melon-inspiration-visual-board-design.md` 中“独立视觉摘要拼图”的页面组织方式；复用其视觉任务、资源授权和安全导入基础

## 1. 背景与根因

当前生产版本只完成了视觉能力第一阶段：`createResearchVisuals` 只调用素材库配色匹配，尚未实现网络证据图 Provider、安全图片导入和 AI 概念图流程。

同时，页面的“视觉摘要”只渲染 `webEvidence + concepts`，而当前服务端固定返回空数组；已经生成的 `libraryMatches` 被放在报告后部的独立区块。因此：

- 视觉摘要必然为空。
- “刷新视觉素材”只重复素材库配色匹配，不会生成真实网络图或商品链接。
- 报告主体仍由长文本、标签页和配色色块组成，不是设计师需要的图文文档。
- 网络来源链接虽然存在于文字报告中，但没有与图片、商品名称和正文段落形成稳定关联。

这不是单一渲染故障，而是网络视觉阶段未实施且页面信息架构与目标不一致。

## 2. 产品目标

将灵感调研结果改造成连续、可阅读、可分享的“编辑式图文文档流”：

1. 真实网页图片进入报告正文，并始终保留原始页面链接。
2. 商品参考展示商品图、品牌或站点、商品名和商品页链接。
3. 图片与结论交替排布，而不是集中到独立视觉面板。
4. 新调研在文字返回后自动补充视觉素材；旧调研允许手动补图或刷新。
5. 图片失败不影响文字报告，单张失败不影响其他图片。
6. AI 生成图只能出现在独立的“概念推演”区域，并明确标注，不能冒充市场证据。
7. 第一阶段先交付真实网络图片、商品链接和编辑式文档流；AI 概念图作为第二阶段独立发布。

## 3. 已确认的产品决策

- 页面采用 A 方案“编辑式长文”。
- 正文证据图必须来自真实网页并可追溯。
- AI 图不进入市场证据或商品参考，只进入文档末尾的概念推演。
- 新报告文字完成后自动启动视觉增强；旧报告保留“补充视觉素材”。
- 商品参考的必填展示字段是商品图、品牌或来源站点、商品名和原页面链接。
- 价格与库存不是必填字段；只有从受信结构化字段可靠获得时才作为可过期的附加信息显示。
- 网络图片通过阿里云百炼联网检索 Agent 获取，不直接抓取指定电商站点，也不在第一阶段引入第二个搜索供应商。
- 无法安全导入的图片被跳过；如果原页面链接有效，仍可作为文字来源保留。
- 刷新时保留上一版已完成图片，新任务成功落库后再原子替换。

## 4. 范围与非目标

### 4.1 第一阶段范围

- 百炼联网检索 Agent 的结构化图像结果接入。
- 网络图安全下载、验证、私有 OSS 转存与授权读取。
- 网络图片的文档角色、来源关联和商品元数据持久化。
- 视觉任务并行执行网络检索与素材库匹配。
- 编辑式图文文档流页面与分享页。
- 新调研自动视觉增强、旧调研补图、刷新、部分失败和删除清理。
- 生产功能开关、真实 Agent 冒烟、金丝雀与蓝绿发布。

### 4.2 第二阶段范围

- Qwen-Image 按设计方向生成概念图。
- 独立概念任务、轮询、私有 OSS 持久化和最多三张限制。
- 文档末尾“概念推演”区域及“AI 生成”标识。
- 显式保存概念图到素材库。

### 4.3 非目标

- 不抓取或保存来源网页正文。
- 不在第一阶段实现价格追踪、库存追踪或购买转化统计。
- 不保证所有电商平台都能返回商品图片。
- 不允许浏览器直接加载第三方图片或长期 OSS 签名地址。
- 不把网络证据图保存为用户素材库资产。
- 不把报告改造成自由拖拽画布。
- 不批量为全部历史报告自动补图。

## 5. 编辑式文档结构

登录态与分享态都遵循同一阅读顺序，私有素材的可见性不同。

```text
报告标题 · 日期 · 来源数量 · 视觉素材数量 · 操作

主视觉
图片说明 · 来源站点 · 打开原始页面

核心结论
摘要 · 可信度说明 · 关键配色

市场信号
信号文字 ── 对应真实证据图
对应真实证据图 ── 信号文字

款式 / 类型 / 风格 / 品类 / 色彩 / 材质
连续章节，不使用标签页隐藏内容

可购买参考
商品图 · 品牌/站点 · 商品名 · 查看商品

设计方向
方向说明 · 廓形 · 配色 · 材质 · 细节
私有素材库关联图（登录态）

概念推演（第二阶段）
明确标注的 AI 生成图

完整来源
```

### 5.1 桌面布局

- `1512 x 982` 和 `1280 x 800` 是主要验收尺寸。
- 报告阅读列最大宽度约 960px，保持长文可读性。
- 主视觉使用稳定宽高比，不使用全屏 Hero。
- 市场信号采用交替图文布局，但 DOM 阅读顺序始终是标题、正文、图片、来源。
- 商品参考使用 3 列；宽度不足时改为 2 列或单列。
- 页面区块通过排版、分隔线和留白组织，不使用卡片套卡片。
- 图片、加载占位和失败占位使用相同纵横比，避免内容跳动。

### 5.2 窄屏布局

- 所有图文段落改为单列。
- 图片说明和来源链接换行，不截断域名或商品名。
- 商品链接与刷新按钮保持可触达尺寸。
- 不缩放正文与按钮字体来换取宽度。

### 5.3 来源交互

- 每张网络图片下方始终显示来源站点和“打开原始页面”。
- 商品项显示“品牌/站点 · 查看商品”。
- 外部链接使用新标签页和 `noopener noreferrer`。
- 图片可打开大图预览；预览重复显示标题、来源站点、查询意图和原页面链接。
- 图片加载失败时保留标题、来源和链接，不显示空白卡槽。

## 6. 总体架构

文字研究仍是核心域，视觉增强继续作为独立附属域。

```text
文字调研 completed
        │
        ├── 浏览器立即展示文字文档
        │
        └── 自动 POST /visuals + operationId
                  │
                  ├── 创建持久化 pending 视觉任务
                  ├── 百炼联网检索 Agent（一次调用）
                  ├── 安全图片导入 + 私有 OSS
                  └── 当前 owner 素材库配色匹配
                           │
                           └── 单次事务完成任务并切换 active job
                                      │
                                      └── 文档组合器生成编辑式 DTO
```

第一阶段不新增常驻任务队列。视觉请求沿用现有持久化 job 和幂等 operation ID：前端自动发起请求并轮询恢复；请求中断留下的 pending job 由现有过期修复逻辑标记 interrupted，用户再次打开时可以重试。

组件边界：

- `web-agent-provider`：只负责官方百炼协议、边界和稳定错误。
- `safe-image-fetch`：只负责 HTTPS、DNS 绑定、重定向、字节和图片验证。
- `web-evidence-importer`：负责候选去重、并发导入、OSS 写入和补偿清理。
- `visual-service`：并行协调网络证据与素材库匹配，原子完成任务。
- `document-composer`：把文字结果和视觉资产转换为稳定文档段落，不依赖供应商协议。
- `InspirationDocument`：只渲染组合后的文档 DTO，不自行猜测图片角色。

## 7. 视觉资产与文档合同

现有 `web_evidence` 资产增加面向文档的受控字段：

```ts
type InspirationDocumentRole = "hero" | "evidence" | "product";

type WebEvidenceAsset = {
  id: string;
  role: InspirationDocumentRole;
  ordinal: number;
  sourceIndexes: number[];
  title: string;
  altText: string;
  imageUrl: string;          // 仅应用内资源路径
  sourcePageUrl: string;     // 凭证为空的 HTTPS 原页面
  sourceSiteName: string;
  sourceQuery: string;
  brand: string | null;
  productName: string | null;
  priceText: string | null;  // 非必填、可过期
  width: number;
  height: number;
};
```

约束：

- 每个 completed 视觉任务最多 8 张网络图。
- 最多 1 张 `hero`、4 张 `product`，其余为 `evidence`。
- `product` 必须有 `productName` 和原页面链接；没有可靠商品语义时降为 `evidence`。
- `sourceIndexes` 只包含当前文字报告已有来源编号，最多 20 个且去重。
- Provider 临时图片 URL、原始 SSE、HTML、OSS 对象键、owner ID 和请求鉴权信息不进入浏览器 DTO。

文档组合器输出：

```ts
type InspirationDocumentDto = {
  hero: WebEvidenceAsset | null;
  intro: { headline: string; summary: string; confidenceNote: string };
  marketSignals: Array<{ signal: TrendFacet; evidence: WebEvidenceAsset[] }>;
  dimensions: Array<{ key: DimensionKey; items: TrendFacet[] }>;
  products: WebEvidenceAsset[];
  directions: Array<{
    direction: InspirationPrompt;
    libraryMatches: LibraryMatchAsset[];
    concepts: GeneratedConceptAsset[];
  }>;
  sources: InspirationSource[];
};
```

组合规则是确定性的：

1. `hero` 取唯一主视觉。
2. 有明确 `sourceIndexes` 的证据图优先进入引用相同来源的市场信号。
3. 剩余证据图按 ordinal 依次分配给没有配图的市场信号；不会复制同一资产。
4. 商品图只进入“可购买参考”。
5. 素材库匹配按 `directionIndex` 进入对应设计方向；没有方向时进入方向章节后的私有补充区。
6. AI 概念图只进入对应方向的“概念推演”。

## 8. 百炼联网检索

使用官方固定接口：

`POST https://dashscope.aliyuncs.com/api/v2/apps/web-search-agent/chat/completions`

请求开启 `stream: true`、`forced_search: true`、`enable_citation: true` 和 `enable_text_image_mixed: true`。一次视觉任务最多调用一次 Agent。

服务端只解析：

```text
message.additional_kwargs.data_type = "image"
message.additional_kwargs.data_json[]
```

不解析或渲染 Provider HTML。候选至少包含图片 URL、原页面 URL、标题、查询词和宽高。

固定提示词从已校验的用户需求、标题、摘要、市场信号、维度和参考款构建，并要求：

- 1 张整体趋势主视觉。
- 2 至 3 张趋势、面料或造型证据图。
- 3 至 4 张真实商品参考图。
- 每张图必须有可访问的原始页面。

角色归类不能只相信自由文本。应用以固定查询意图、候选原页面与当前 `sources/referenceLooks` 的来源关系为主进行确定性归类；无法证明商品语义的候选统一降为 `evidence`，不显示为可购买商品。

新增配置沿用既定命名：

- `INSPIRATION_WEB_VISUALS_ENABLED`
- `DASHSCOPE_WEB_SEARCH_AGENT_ID`
- `DASHSCOPE_WEB_SEARCH_AGENT_VERSION`
- `INSPIRATION_VISUAL_MAX_IMAGES`，生产固定为 8

`refreshAvailable` 在网络视觉或素材库匹配任一能力可用时为 true，不能继续只依赖 `IMAGE_SEARCH_ENABLED`。

## 9. 安全图片导入

沿用已确认的网络证据安全边界：

- 只接受无用户名、密码和片段的 HTTPS URL。
- 所有 DNS 结果必须是公网地址；实际 TLS 连接绑定已验证地址并保留原 Host/SNI。
- 每次重定向重新验证，最多 3 次。
- 响应头最大 16 KiB，图片最大 8 MiB。
- 总时限 15 秒，空闲时限 5 秒。
- 最大 4000 万解码像素。
- 只允许 JPEG、PNG、WebP 和 GIF，MIME、魔数与尺寸必须一致。
- 拒绝 SVG、HTML、脚本、多部分响应、截断和多义文件。
- 不记录 API Key、Authorization、响应正文、完整临时 URL、URL 查询串或 OSS 对象键。

导入并发为 3。每张图片独立处理；单张失败只产生稳定 warning。合格图片写入：

`users/{ownerId}/inspiration/{analysisId}/research/{jobId}/{assetId}.{ext}`

浏览器通过 owner/share 授权的应用资源路由读取字节，不接收远程图片 URL 或 OSS 签名 URL。

## 10. 自动生成、刷新与状态

### 10.1 新调研

1. 文字分析成功后页面立即进入 completed 文档。
2. 客户端自动创建唯一 operation ID 并调用 `/visuals`。
3. 页面按稳定比例显示视觉占位，不覆盖或锁定文字正文。
4. 任务完成后原位填充主视觉、证据图、商品图和素材库关联图。

同一分析在自动视觉请求 pending 时禁止再次发起；导航离开不会丢失已完成文字结果。

### 10.2 旧调研与刷新

- 没有 active 视觉任务时显示“补充视觉素材”。
- 有 active 任务时显示“刷新视觉素材”。
- 刷新创建新 job，旧 active 资产持续可见。
- 新 job 完成事务提交后才切换 active job，并异步清理被替代的网络缓存。
- 新 job 失败时继续展示旧 active 资产和局部重试提示。

### 10.3 失败语义

- 网络成功、素材库为空：任务完成。
- 网络部分成功：任务完成并显示现有图片，不显示笼统失败横幅。
- 网络失败、素材库成功：任务完成，文档显示素材库内容和网络重试提示。
- 网络与素材库都失败或为空：视觉任务失败，但文字文档保持完整。
- 图片资源后续丢失：显示保留来源链接的占位，不删除文字证据。
- Provider disabled：明确显示“网络视觉参考暂未开启”，但刷新按钮仍可在素材库匹配可用时工作。

错误码继续使用稳定集合，不向用户或日志透传供应商正文。

## 11. 删除、分享与生命周期

- 删除分析先级联删除视觉行，再 best-effort 删除该分析的研究图片对象。
- 删除失败对象进入运维补偿边界，不恢复已删除分析。
- 网络图片缓存配置 30 天 OSS 生命周期；元数据和来源链接随报告保留。
- 分享页展示 completed 网络证据图、商品链接和第二阶段已完成的 AI 图。
- 分享页不展示素材库关联图、pending/failed job、Provider ID、owner ID、对象键或内部错误。
- 撤销分享后分享资源路由立即返回 404；不要求立即删除私有图片。

## 12. 组件与页面改造

第一阶段新增或调整：

- `InspirationDocument`：文档总编排与连续章节。
- `InspirationHeroEvidence`：主视觉、说明和来源。
- `InspirationSignalSection`：市场信号与证据图交替布局。
- `InspirationDimensionSections`：替换标签页，纵向渲染全部维度。
- `InspirationProductReferences`：商品图、品牌/站点、商品名和链接。
- `InspirationDirectionSection`：方向文字和私有素材匹配。
- `InspirationEvidenceDialog`：大图、元数据和原页面动作。
- `InspirationVisualStatus`：局部加载、部分失败和刷新动作。

原 `InspirationVisualBoard placement="summary"` 不再作为独立首屏区块。迁移期间可以保留适配层，但最终文档组件直接消费组合后的 DTO。

## 13. 测试策略

### 13.1 单元测试

- Agent 请求字段、SSE 任意分块、上限、重复和恶意响应。
- 候选角色归类、来源编号映射和商品降级规则。
- 公网 IP 分类、DNS pinning、重定向、超时、大小、MIME、魔数和像素限制。
- 文档组合器的 hero、证据分配、商品隔离和稳定排序。
- UI 在 0、1、4、8 张图片及资源失败时的文档顺序与来源链接。

### 13.2 集成测试

- owner 隔离、operation replay、并发 pending、刷新原子切换。
- 网络与素材库的成功、部分成功、全空和中断组合。
- OSS 写入后数据库失败的补偿删除。
- 删除调研的行与对象清理。
- 登录态、分享态、撤销分享和跨 owner 资源 404。

### 13.3 浏览器与真实服务测试

- `1512x982`、`1280x800`、`390x844` 无重叠、横向溢出或明显布局跳动。
- 键盘可访问大图、刷新和外部链接。
- 真实 Agent 冒烟最多一次请求，不打印 URL 或凭据。
- 真实报告至少包含 1 张主视觉、1 张证据图、1 张商品图和可访问原页面；如果真实 Provider 没有返回可靠商品图，发布门禁失败而不是伪造商品卡。

## 14. 分阶段实施与发布

### 14.1 第一阶段：真实网络图文文档

1. 加性数据库迁移与合同扩展。
2. Provider、协议和安全图片导入。
3. OSS 资源路由、任务编排和生命周期。
4. 文档组合器与编辑式页面。
5. 分享页、删除与回归测试。
6. 真实 Agent/OSS 冒烟和目标视口 QA。

### 14.2 第二阶段：AI 概念推演

第一阶段稳定后，按已有 Qwen-Image 计划实施概念任务、轮询、持久化、方向内图库和保存到素材库。第二阶段不改变市场证据和商品参考合同。

### 14.3 生产发布

1. 数据库迁移、代码与资源路由先上线，`INSPIRATION_WEB_VISUALS_ENABLED=false`。
2. 在独立候选进程配置真实 Agent 和 OSS，运行一份完整调研并检查所有来源链接。
3. 验证刷新保留旧结果、删除清理和分享撤销。
4. 蓝绿切流 Web 服务，保持旧 release 和环境文件备份。
5. 私有邀请用户范围内开启网络视觉开关。
6. 观察错误率、导入成功数、任务耗时、内存和 OSS 增长，不记录用户查询正文或远程 URL。

回滚只需关闭 `INSPIRATION_WEB_VISUALS_ENABLED` 并回退页面 release。文字调研、已有文字历史和素材库继续工作；数据库加性字段与已经缓存的图片保留，待生命周期或清理任务处理。

## 15. 验收标准

- 新报告文字可先读，随后无需手动点击即可出现真实网络图片。
- 报告是连续编辑式文档，不再显示空的独立视觉摘要。
- 每张网络图片都有来源站点和原页面链接。
- 商品卡有可靠商品图、品牌/站点、商品名和商品页链接；不可靠候选不伪装为商品。
- 正文至少支持主视觉、市场证据图和商品参考三种角色。
- 刷新成功后原子替换，失败时保留上一版视觉结果。
- 单张图片失败不影响其他图片；全部视觉失败不影响文字报告。
- 浏览器、公开 DTO 和日志不泄露 Provider 临时 URL、OSS 对象键、凭据或跨用户资产。
- 登录态与分享态在目标视口稳定、可访问，私有素材只在登录态显示。
- 第一阶段生产真实冒烟通过后再开启功能开关；AI 概念图不阻塞第一阶段上线。
