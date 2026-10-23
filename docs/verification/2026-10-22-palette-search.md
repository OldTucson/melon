# 配色搜索上线验证

验证日期：2026-10-23

## 结论

`visual-search-v2` 已在本地开发环境完成回填，并通过自动化测试、真实服务浏览器 smoke test 与 10,000 候选配色基准。当前本地图库的 5 个有效图案均已发布 embedding 和 5 色调色板，配色搜索与以图搜图均可用。

生产环境尚未获准启用。生产配置继续保持 `IMAGE_SEARCH_ENABLED=false`，直到 100 张真实图库质量门禁、生产等规格 ECS 性能与内存门禁、RAM Role/IMDSv2 检查全部通过。

## 本地发布证据

- 数据库迁移成功，v2 回填扫描 5 个图案并插入 5 个任务。
- 5 个任务均为 `complete`，5 个文档均为 `ready`，无 terminal failure。
- 5 个 ready 文档均有 5 个有效、唯一、连续排序的 HEX 色值，coverage 总和符合容差。
- API health 报告 `indexVersion=visual-search-v2`、`modelLoaded=true`、`status=ok`。
- 本地 OSS 身份可以读取预览，但写入派生特征目录时返回 `403 AccessDenied`。开发环境因此使用 `VISUAL_SEARCH_FEATURE_STORAGE_DIR` 保存特征归档，预览仍从真实 OSS 读取；本地归档先完整写入 staging 文件，再以不可覆盖的原子链接发布。该设置在 production 配置中会被拒绝，不能替代生产 RAM Role 权限。

## 自动化验证

| 检查 | 结果 |
| --- | --- |
| Python pytest | 397 passed, 1 skipped，10.02s |
| Ruff | PASS |
| mypy strict | 19 个源文件 PASS |
| Vitest unit | 127 个文件、1040 个测试 PASS，26.38s |
| Vitest integration | 32 个文件 PASS、1 个文件 skipped；330 passed、1 skipped，47.71s |
| TypeScript typecheck | PASS，8.25s |
| ESLint | PASS，8.06s |
| Next.js production build | PASS；编译 445ms、类型检查 1665ms、生成 27 个静态页面，总计 4.05s |
| Playwright | 8 passed、4 个真实模型用例按预期 skipped，32.2s；Chrome 桌面/手机及 WebKit 桌面/1024 均通过 |

首次启动 Next.js 16.4 dev server 时，框架因已知安全升级提示主动停止；在提示允许的时间窗口内以相同命令重启后，Playwright 全部通过。升级到包含修复的 Next.js 版本是独立的上线前事项。

## 真实浏览器验证

使用本地 PostgreSQL、真实 v2 Python API、worker、模型和真实 OSS 预览验证 `http://127.0.0.1:3000/library`：

- 5 张卡片共显示 25 个色块，每张 5 个。
- 单色和双色配色请求均返回 HTTP 200；PSD 筛选后得到 1 条结果，重置后恢复 5 条。
- 配色搜索与以图搜图互斥，并能恢复搜索前的工作区状态。
- 取一张真实预览上传以图搜图，HTTP 200，返回 4 条结果。
- 桌面明暗主题和手机暗色主题无水平溢出，色块、缩略图和工具栏无重叠或裁切。
- 无页面错误、控制台错误或阻塞请求失败；仅观察到 4 次 Next.js RSC 导航预期中的 `net::ERR_ABORTED`。

截图保存在本地忽略目录 `test-results/local-palette-smoke/`，不随 Git 提交。

## 配色性能基准

命令参数：10,000 个候选、30 次迭代、seed `20261022`。

- p50：242.339125 ms
- p95：280.935333 ms
- 总耗时：9.89s
- 峰值 RSS：154,435,584 bytes（约 147 MiB）
- 主机：Apple M1 Pro、32 GiB、arm64、macOS 26.6.2

该结果只用于本地诊断，不满足生产门禁。

## 尚未完成的生产门禁

- 使用至少 100 个 v2 ready 图案完成真实图库质量基准；本地当前只有 5 个可用图案。
- 在生产等规格 ECS 上复跑原图搜索与 10,000 候选配色基准，并记录镜像 digest、CPU、内存、p50、p95 与 OOM 情况。
- 验证 ECS RAM Role 的最小 OSS 权限、IMDSv2 可用且 IMDSv1 已禁用。
- 升级 Next.js 到包含对应安全修复的版本并重新执行全套验证。
- 上述门禁完成前保持生产 `IMAGE_SEARCH_ENABLED=false`。
