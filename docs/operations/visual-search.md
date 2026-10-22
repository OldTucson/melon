# 以图搜图生产运行手册

本文适用于 `visual-search-v1`。Python API 是 Next.js 的内部依赖，不是公网服务；正式启用前必须完成真实图库质量和生产 ECS 性能门禁。当前验证记录仍将这两项标为未完成，因此默认保持 `IMAGE_SEARCH_ENABLED=false`。

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
VISUAL_SEARCH_ACTIVE_VERSION=visual-search-v1
VISUAL_SEARCH_MODEL_SHA256=e306c964ab0a1a9bdb334af89ab657d58448417b830a6a7f7b742f85d4441ae8
VISUAL_SEARCH_MODEL_HOST_PATH=/opt/melon/models/dinov2-small.onnx
VISUAL_SEARCH_TEMP_HOST_PATH=/var/lib/melon/visual-search/tmp
VISUAL_SEARCH_REPORT_HOST_PATH=/var/lib/melon/visual-search/reports
VISUAL_SEARCH_OSS_REGION=oss-cn-hangzhou
VISUAL_SEARCH_OSS_BUCKET=replace-with-private-bucket
VISUAL_SEARCH_OSS_ENDPOINT=https://assets.example.com
VISUAL_SEARCH_PRODUCTION_DATABASE_NAME=replace-with-production-database-name
VISUAL_SEARCH_MAX_CONCURRENCY=1
```

Next.js 的 `IMAGE_SEARCH_INTERNAL_TOKEN` 必须与上面的 `VISUAL_SEARCH_INTERNAL_TOKEN` 完全相同；`IMAGE_SEARCH_SERVICE_URL` 固定为 `http://127.0.0.1:8091`。不要把环境文件传给镜像构建，也不要在 `docker compose config` 输出中保留展开后的密钥。

## 首次上线顺序

必须严格按下列顺序执行：

1. 对 PostgreSQL 做可恢复备份。在目标数据库确认有权执行 `CREATE EXTENSION vector`，运行迁移后用 `select extversion from pg_extension where extname = 'vector';` 验证 pgvector 版本不低于 `0.8.0`。
2. 保持 Next.js 的 `IMAGE_SEARCH_ENABLED=false`，部署并执行 `npm run db:migrate`。此时现有图库功能仍独立可用。
3. 给 ECS 绑定专用 ECS 实例 RAM 角色，验证 IMDSv2 可取得临时凭证且 IMDSv1 已禁用。不要给浏览器 STS 角色增加 search 派生对象权限。
4. 按上一节安装并校验 ONNX 文件，构建镜像后以 registry digest 填写 `VISUAL_SEARCH_IMAGE`。启动过程中禁止下载模型。
5. 安装并启动 API 与单并发 worker，随后验证带鉴权的 loopback health：

   ```bash
   sudo install -o root -g root -m 0644 deploy/systemd/melon-visual-search*.service /etc/systemd/system/
   sudo install -o root -g root -m 0644 deploy/systemd/melon-visual-search-cleanup.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now melon-visual-search.service melon-visual-search-worker.service
   set -a; source /etc/melon/visual-search.env; set +a
   curl -fsS -H "Authorization: Bearer $VISUAL_SEARCH_INTERNAL_TOKEN" \
     http://127.0.0.1:8091/internal/health
   ```

6. 从应用目录运行幂等回填：

   ```bash
   npm run image-search:backfill -- --version visual-search-v1
   ```

7. 在设置页观察 ready/failed/积压与 worker 心跳。选定一个拥有至少 100 个 ready 索引的真实图库 owner，运行固定基准：

   ```bash
   docker compose -f deploy/compose.visual-search.yaml --profile tools run --rm \
     visual-search-cli benchmark \
     --owner-id "$MELON_OWNER_ID" \
     --count 100 \
     --seed 20261020 \
     --output /reports/melon-visual-search-production.json
   ```

8. 在同规格生产 ECS 记录搜索 P95、峰值内存和重启/OOM 情况。要求 P95 不超过 8 秒且无 OOM；开发 Mac 的结果不能替代该门禁。确认报告不含图片、对象 key、签名 URL或密钥，并确认临时目录没有超过请求超时仍残留的查询图。
9. 只有真实图库所有质量门槛、跨 owner 隔离、ECS 性能和内存门槛全部通过后，才在 Next.js 环境设置 `IMAGE_SEARCH_ENABLED=true` 并重启应用。用 JPG、粘贴、裁剪和筛选变更各做一次 smoke test。

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

回滚时先将 Next.js 的 `IMAGE_SEARCH_ENABLED=false` 并重启应用，然后停止两个服务：

```bash
sudo systemctl stop melon-visual-search-worker.service melon-visual-search.service
```

回滚不 drop 表、不回退已应用迁移、不删除 ready 索引或 OSS 派生特征。保留数据便于修复后恢复；只有经过单独审核的清理流程才能删除派生对象。文字搜索、上传、下载和普通图库浏览应继续工作。
