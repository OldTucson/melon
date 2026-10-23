# 以图搜图生产运行手册

本文适用于带配色色卡的 `visual-search-v2`，并保留 `visual-search-v1` 作为版本化回滚目标。Python API 是 Next.js 的内部依赖，不是公网服务；正式启用前必须完成真实图库质量和生产 ECS 性能门禁。当前验证记录仍将这些生产门禁标为未完成，因此生产环境保持 `IMAGE_SEARCH_ENABLED=false`。

## 安全边界

- API 只通过 Compose 发布到宿主机 `127.0.0.1:8091`。容器内监听 `0.0.0.0` 仅用于 Docker bridge 转发，安全边界是宿主机 loopback 映射和安全组不开放 8091；不要改成 `0.0.0.0:8091:8091`。
- Next.js 与 Python 使用同一个至少 32 字节的随机内部 token。token 只存在于 Git 外的 root 可读环境文件，不进入浏览器变量、命令输出或日志。
- API、worker 和 CLI 使用同一个 digest 固定的镜像。容器以 UID/GID `10001`、只读根文件系统、空 capabilities 和 `no-new-privileges` 运行。
- ONNX 模型不打进镜像，也不在启动时下载。入口进程在执行任何服务命令前核对 `model-lock.json`、`VISUAL_SEARCH_MODEL_SHA256` 和只读挂载文件的大小及 SHA-256。
- Python SDK 在生产环境使用 ECS 实例 RAM 角色。ECS 必须启用安全强化模式/IMDSv2，并在实例元数据设置中禁用 IMDSv1；生产环境不配置长期 AccessKey。
- ECS 角色的对象权限只覆盖现有 `users/*/patterns/*` 树。浏览器 STS policy 保持原有 `AbortMultipartUpload`、`ListParts`、`PutObject` 三项，不增加搜索特征读取、列举或删除权限。完整 policy 见[阿里云 OSS 运行配置](./aliyun-oss.md)。

## 主机准备

建议生产 ECS 至少 2 vCPU、4 GiB 内存。安装 Docker Engine、Compose plugin、curl 和 systemd。将仓库部署到 `/opt/melon`，然后创建运行目录：

```bash
sudo install -d -o root -g root -m 0755 /opt/melon/models
sudo install -d -o 10001 -g 10001 -m 0700 \
  /var/lib/melon/visual-search/tmp \
  /var/lib/melon/visual-search/reports
```

将审核过的模型安装为 `/opt/melon/models/dinov2-small.onnx`，设为 root 拥有、只读，并核对锁文件中的 SHA：

```bash
sudo install -o root -g root -m 0444 \
  dinov2-small.e306c964ab0a1a9bdb334af89ab657d58448417b830a6a7f7b742f85d4441ae8.onnx \
  /opt/melon/models/dinov2-small.onnx
sha256sum /opt/melon/models/dinov2-small.onnx
```

预期 SHA-256 为 `e306c964ab0a1a9bdb334af89ab657d58448417b830a6a7f7b742f85d4441ae8`。不匹配时禁止启动；不要重命名其他权重来绕过预检。

创建 `/etc/melon/visual-search.env`，权限设为 `root:root 0600`。示例中的值均须替换：

```dotenv
VISUAL_SEARCH_IMAGE=registry.example.com/melon-visual-search@sha256:replace-with-image-digest
VISUAL_SEARCH_DATABASE_URL=postgres://replace-with-runtime-connection
VISUAL_SEARCH_INTERNAL_TOKEN=replace-with-one-random-token-at-least-32-characters
VISUAL_SEARCH_ACTIVE_VERSION=visual-search-v2
VISUAL_SEARCH_MODEL_SHA256=e306c964ab0a1a9bdb334af89ab657d58448417b830a6a7f7b742f85d4441ae8
VISUAL_SEARCH_MODEL_HOST_PATH=/opt/melon/models/dinov2-small.onnx
VISUAL_SEARCH_TEMP_HOST_PATH=/var/lib/melon/visual-search/tmp
VISUAL_SEARCH_REPORT_HOST_PATH=/var/lib/melon/visual-search/reports
VISUAL_SEARCH_OSS_REGION=cn-hangzhou
VISUAL_SEARCH_OSS_BUCKET=replace-with-private-bucket
VISUAL_SEARCH_OSS_ENDPOINT=https://assets.example.com
VISUAL_SEARCH_PRODUCTION_DATABASE_NAME=replace-with-production-database-name
VISUAL_SEARCH_MAX_CONCURRENCY=1
```

Next.js 的 `IMAGE_SEARCH_INTERNAL_TOKEN` 必须与上面的 `VISUAL_SEARCH_INTERNAL_TOKEN` 完全相同；`IMAGE_SEARCH_SERVICE_URL` 固定为 `http://127.0.0.1:8091`。不要把环境文件传给镜像构建，也不要在 `docker compose config` 输出中保留展开后的密钥。

Python OSS SDK V2 的 `VISUAL_SEARCH_OSS_REGION` 使用 `cn-hangzhou` 形式，不带 `oss-` 前缀；Next.js 使用的 `ALIYUN_OSS_REGION` 仍保持 `oss-cn-hangzhou` 形式。两者不要直接复用。

本地 RAM 身份尚未获得派生特征目录写权限时，可在非生产环境设置绝对路径 `VISUAL_SEARCH_FEATURE_STORAGE_DIR`。预览仍从真实 OSS 读取，局部特征归档则由 API 与 worker 共享该本机目录；目录应设为仅当前用户可读写，且两个进程必须使用同一路径。生产配置会拒绝此变量，ECS 仍必须使用前述最小权限 RAM Role 和 OSS 存储。

上述值是最终目标配置。由 v1 升级到 v2 时，在完成回填和门禁前，API、worker 与 Next.js 必须继续使用 `visual-search-v1`，不得提前使用示例中的 v2 值。

## v2 上线顺序

必须严格按下列顺序执行：

1. 对 PostgreSQL 做可恢复备份。在目标数据库确认有权执行 `CREATE EXTENSION vector`，然后保持 `IMAGE_SEARCH_ENABLED=false` 并运行 `npm run db:migrate`。用 `select extversion from pg_extension where extname = 'vector';` 验证 pgvector 版本不低于 `0.8.0`。
2. 给 ECS 绑定专用实例 RAM 角色，验证 IMDSv2 可取得临时凭证且 IMDSv1 已禁用。按上一节校验 ONNX 文件，以 registry digest 部署支持 v2 的同一版 API 与 worker，但暂时把 API、worker 的 `VISUAL_SEARCH_ACTIVE_VERSION` 和 Next.js 的 `IMAGE_SEARCH_ACTIVE_VERSION` 都保持为 `visual-search-v1`。启动过程中禁止下载模型。
3. 安装并启动 API 与单并发 worker，随后验证带鉴权的 loopback health 仍报告 v1：

   ```bash
   sudo install -o root -g root -m 0644 deploy/systemd/melon-visual-search*.service /etc/systemd/system/
   sudo install -o root -g root -m 0644 deploy/systemd/melon-visual-search-cleanup.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now melon-visual-search.service melon-visual-search-worker.service
   set -a; source /etc/melon/visual-search.env; set +a
   curl -fsS -H "Authorization: Bearer $VISUAL_SEARCH_INTERNAL_TOKEN" \
     http://127.0.0.1:8091/internal/health
   ```

4. 从应用目录幂等地排入 v2 回填；这一步只新增版本化任务，不切换线上读路径：

   ```bash
   npm run image-search:backfill -- --version visual-search-v2
   ```

5. 在设置页和数据库按 owner/version 观察 ready、failed、积压与 worker 心跳。必须等每个符合条件的 preview 都成为 v2 `complete`/`ready`，或逐项调查并记录 terminal failure；不得通过忽略 failed 项宣称回填完成。每个 v2 ready 文档必须有 3-5 个连续索引、HEX 唯一且 coverage 总和在 `1 ± 1e-5` 内的色卡。
6. 选定一个拥有至少 100 个 v2 ready 索引的真实图库 owner，显式用 v2 运行原图质量门禁：

   ```bash
   docker compose -f deploy/compose.visual-search.yaml --profile tools run --rm \
     -e VISUAL_SEARCH_ACTIVE_VERSION=visual-search-v2 \
     visual-search-cli benchmark \
     --owner-id "$MELON_OWNER_ID" \
     --count 100 \
     --seed 20261020 \
     --output /reports/melon-visual-search-production.json
   ```

7. 在同规格生产 ECS 运行 10,000 候选配色基准，并记录 CPU、内存、镜像 digest、主机规格、p50 与 p95；报告不得记录查询色值：

   ```bash
   docker compose -f deploy/compose.visual-search.yaml --profile tools run --rm \
     visual-search-cli palette-benchmark \
     --count 10000 \
     --iterations 30 \
     --seed 20261022 \
     --output /reports/melon-palette-search-production.json
   ```

   原图搜索 P95 必须不超过 8 秒，配色 API P95 必须不超过 1,000 ms，且全程无 OOM。开发 Mac 的结果不能替代 ECS 门禁。确认报告不含图片、对象 key、签名 URL、密钥或查询色值，并确认临时目录没有超过请求超时仍残留的查询图。
8. 只有回填、真实图库质量、跨 owner 隔离和两项 ECS 性能门禁全部通过后，才把 API/worker 的 `VISUAL_SEARCH_ACTIVE_VERSION` 与 Next.js 的 `IMAGE_SEARCH_ACTIVE_VERSION` **同时**改为 `visual-search-v2`，并在同一个发布窗口重启 API、单 worker 和 Next.js。health 必须报告 v2，三者版本不一致时立即停止发布。
9. 版本切换确认后才设置现有的 `IMAGE_SEARCH_ENABLED=true` 并重启 Next.js。分别 smoke test 正常图库、JPG/粘贴/裁剪搜图、单色/三色/五色配色搜索、筛选重算、清除恢复以及两种搜索互斥。

任何一步失败都停止上线，不得通过放宽“高概率原图”阈值掩盖召回问题。

## 日常运行

启用每日派生对象清理并查看下次执行时间：

```bash
sudo systemctl enable --now melon-visual-search-cleanup.timer
systemctl list-timers melon-visual-search-cleanup.timer
```

API systemd unit 设置 `MemoryMax`、启动退避、private temp 和带 token 的 readiness probe；Compose 同时设置容器内存、CPU、PID、只读根文件系统与健康检查。worker 固定单进程，失败由 systemd 重启。对以下情况告警：API health 失败、worker 心跳超过 45 秒、failed/积压持续增长、容器 OOM/重启、清理任务非零退出、临时目录出现超龄文件。

升级时先拉取 digest 固定的新镜像，执行 `docker compose ... config --quiet`，再依次重启 API 和 worker。模型或索引版本变化必须走新的版本化回填与质量验证，不能覆盖正在服务的 ready 文档。

## 回滚

回滚只改配置，不删除索引数据。先将 Next.js 的 `IMAGE_SEARCH_ENABLED=false` 并重启应用，再把 Next.js 的 `IMAGE_SEARCH_ACTIVE_VERSION` 以及 API/worker 的 `VISUAL_SEARCH_ACTIVE_VERSION` 一起改回 `visual-search-v1`，随后重启三者并核对 health：

```bash
sudo systemctl restart melon-visual-search.service melon-visual-search-worker.service
```

回滚不 drop 表、不回退已应用迁移、不删除 v2 palette 行、ready 索引或 OSS 派生特征。保留数据便于修复后再次切换；只有经过单独审核的清理流程才能删除派生对象。文字搜索、上传、下载和普通图库浏览应继续工作。
