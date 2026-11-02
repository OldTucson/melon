# Melon 主站生产运行手册

本手册覆盖单台 Linux 主机上的 Next.js 主站、PostgreSQL/RDS、私有 OSS、反向代理和 systemd 维护任务。主站仅监听 `127.0.0.1:3000`，公网流量必须先经过终止 TLS 的反向代理。以图搜图服务继续按[独立运行手册](visual-search.md)部署，不属于主站 readiness 的依赖。

## 上线前仍需人工完成的门禁

仓库检查不能替代以下真实环境确认。任何一项未完成时，都保持 `IMAGE_SEARCH_ENABLED=false`，不要把发布标记改为通过。

- 管局审核完成后，将真实 ICP 备案号写入 `ICP_FILING_NUMBER`；公安备案号与查询 URL 必须成对填写，未取得时保持两项为空。
- 在生产 Bucket 核对 OSS 私有读写、CORS、服务端列举权限和生命周期策略。
- 在阿里云核对 RAM 最小权限、STS 浏览器上传角色和 ECS 实例 RAM 角色；生产环境不得配置长期 AccessKey。
- 在生产 ECS 验证 IMDSv2、仅回环监听、防火墙、磁盘容量、时间同步和系统补丁。
- 使用至少 100 张有代表性的真实图片完成以图搜图质量、延迟和失败恢复门禁，并保存验证记录；通过后才设置 `IMAGE_SEARCH_RELEASE_APPROVED=true`。
- 在实际 RDS 上完成一次快照恢复或逻辑备份恢复演练，并记录恢复时间与校验结果。

## 主机基线

使用受支持的 Node.js 24 版本，最低使用 `24.15.0`，并固定在 24.x 内升级。安装 npm、Git、PostgreSQL 客户端、curl、systemd 和反向代理。生产进程使用无登录 shell 的 `melon` 用户，不使用 root 运行 Node.js：

```bash
sudo useradd --system --home-dir /opt/melon --create-home --shell /usr/sbin/nologin melon
sudo install -d -o melon -g melon -m 0750 /opt/melon/releases
sudo install -d -o root -g root -m 0700 /var/backups/melon
sudo install -d -o root -g root -m 0755 /etc/melon
node --version
npm --version
```

`node --version` 必须显示 Node.js 24。防火墙只向公网开放反向代理的 `80/443`，不得开放 `3000` 或图搜服务端口。

## 生产环境文件

环境文件由 root 所有并设为 `0600`。systemd 在降权到 `melon` 用户前读取它，应用用户不需要直接读取该文件：

```bash
sudo install -o root -g root -m 0600 /dev/null /etc/melon/web.env
sudo stat -c '%U %G %a %n' /etc/melon/web.env
```

在 `/etc/melon/web.env` 中设置真实值，至少包含：

```dotenv
NODE_ENV=production
DATABASE_URL=
AUTH_SECRET=
AUTH_TRUST_PROXY=true
APP_ORIGIN=https://your-production-host.example

SITE_OPERATOR_NAME=
SITE_CONTACT_EMAIL=
SITE_LEGAL_EFFECTIVE_DATE=
ICP_FILING_NUMBER=
PUBLIC_SECURITY_FILING_NUMBER=
PUBLIC_SECURITY_FILING_URL=

ALIYUN_OSS_REGION=
ALIYUN_OSS_BUCKET=
ALIYUN_OSS_ENDPOINT=
ALIYUN_OSS_CNAME=true
ALIYUN_STS_ROLE_ARN=
OSS_ADAPTER=real

IMAGE_SEARCH_ENABLED=false
IMAGE_SEARCH_RELEASE_APPROVED=false
```

要求：

- `AUTH_SECRET` 使用密码学安全随机值，不能沿用示例值。
- `DATABASE_URL` 指向生产数据库，库名不能以 `_test`、`_e2e` 或 `_performance_test` 结尾。
- 不设置 `ALIBABA_CLOUD_ACCESS_KEY_ID` 和 `ALIBABA_CLOUD_ACCESS_KEY_SECRET`；ECS 使用实例 RAM 角色。
- `SITE_OPERATOR_NAME`、`SITE_CONTACT_EMAIL` 和 `SITE_LEGAL_EFFECTIVE_DATE` 在正式对外前必须填写。
- 公安备案号与 URL 要么同时为空，要么同时填写；不得使用虚构编号。
- 只有反向代理已覆盖可信客户端 IP 头且应用端口不对公网开放时，才允许 `AUTH_TRUST_PROXY=true`。

每次修改后先在目标主机执行预检。推荐通过 transient systemd unit 读取 root-only 环境文件：

```bash
sudo systemd-run --wait --pipe --collect \
  --uid=melon --gid=melon \
  --property=EnvironmentFile=/etc/melon/web.env \
  --working-directory=/opt/melon/current \
  /usr/bin/npm run prod:check
```

只有输出 `Production preflight: PASS` 才能继续。失败输出只有固定错误码，不应包含任何环境变量值。

## 发布目录和制品

每次发布使用一个明确、不可复用的 release ID。不要把日期命令替换成未核对的通配路径；以下值只是命名示例：

```bash
release_id=20261023T160000Z
release_dir=/opt/melon/releases/$release_id
sudo install -d -o melon -g melon -m 0750 "$release_dir"
```

将已经审查的 Git 提交或 CI 制品解压到该目录，确认其中包含 `package.json`、`package-lock.json`、`drizzle/`、`deploy/`、`scripts/` 和 `src/`，并记录提交 SHA：

```bash
sudo -u melon git -C "$release_dir" rev-parse HEAD
sudo -u melon npm ci --registry=https://registry.npmjs.org --prefix "$release_dir"
```

`npm ci` 必须使用官方 registry 和锁文件。不要在生产主机运行 `npm update` 或 `npm audit fix`。

## 发布质量门禁

完整验证应先在同一提交的 CI 或隔离预发布环境执行，测试数据库和 E2E 资源不得指向生产数据：

```bash
npm audit --omit=dev --registry=https://registry.npmjs.org
npm test
npm run test:integration
npm run typecheck
npm run lint
npm run build
npm run test:e2e
```

保留每个命令的退出码、测试数量和 E2E 跳过原因。真实 OSS、RDS 恢复和 100 图片图搜门禁必须单独记录，不能用单元测试替代。

在目标主机用生产环境构建 standalone 制品：

```bash
sudo systemd-run --wait --pipe --collect \
  --unit="melon-build-$release_id" \
  --uid=melon --gid=melon \
  --property=EnvironmentFile=/etc/melon/web.env \
  --working-directory="$release_dir" \
  /usr/bin/npm run build
```

## 数据库备份与恢复演练

迁移前先创建 RDS 手动快照，并做一份 PostgreSQL custom-format 逻辑备份。备份文件名必须使用当前 release ID，目录必须是 `/var/backups/melon`：

```bash
sudo /bin/bash -ec '
  set -a
  . /etc/melon/web.env
  set +a
  umask 077
  /usr/bin/pg_dump --format=custom --file=/var/backups/melon/20261023T160000Z.dump "$DATABASE_URL"
  /usr/bin/sha256sum /var/backups/melon/20261023T160000Z.dump > /var/backups/melon/20261023T160000Z.dump.sha256
'
sudo /usr/bin/sha256sum --check /var/backups/melon/20261023T160000Z.dump.sha256
```

恢复演练必须指向隔离的临时 RDS 实例或明确命名的空数据库，例如 `melon_restore_drill_20261023T160000Z`，绝不能指向生产 `DATABASE_URL`。把临时连接串写入 root-only 的 `/etc/melon/restore-drill.env`，然后执行：

```bash
sudo /bin/bash -ec '
  set -a
  . /etc/melon/restore-drill.env
  set +a
  /usr/bin/pg_restore --exit-on-error --no-owner --dbname="$RESTORE_DATABASE_URL" /var/backups/melon/20261023T160000Z.dump
  /usr/bin/psql "$RESTORE_DATABASE_URL" --set=ON_ERROR_STOP=1 --command="select count(*) from users"
  /usr/bin/psql "$RESTORE_DATABASE_URL" --set=ON_ERROR_STOP=1 --command="select count(*) from patterns"
'
```

记录快照 ID、备份校验和、恢复开始/结束时间和抽样计数。恢复演练未通过时停止发布。

## 迁移、裁剪和原子切换

迁移前确认生产环境仍为 `IMAGE_SEARCH_ENABLED=false`，停止图搜 worker，并验证当前主站仍可服务。使用尚未裁剪开发依赖的 release 目录运行迁移：

```bash
sudo systemd-run --wait --pipe --collect \
  --unit="melon-migrate-$release_id" \
  --uid=melon --gid=melon \
  --property=EnvironmentFile=/etc/melon/web.env \
  --property=Environment=IMAGE_SEARCH_ENABLED=false \
  --working-directory="$release_dir" \
  /usr/bin/npm run db:migrate
```

迁移成功后复制 Next.js standalone 不会自动包含的静态资源。`public` 仅在目录存在时复制：

```bash
sudo -u melon install -d "$release_dir/.next/standalone/.next"
sudo -u melon cp -R "$release_dir/.next/static" "$release_dir/.next/standalone/.next/static"
if [ -d "$release_dir/public" ]; then
  sudo -u melon cp -R "$release_dir/public" "$release_dir/.next/standalone/public"
fi
sudo -u melon npm prune --omit=dev --prefix "$release_dir"
```

裁剪后再次运行生产预检，确认 `tsx` 和维护命令仍可执行：

```bash
sudo systemd-run --wait --pipe --collect \
  --unit="melon-preflight-$release_id" \
  --uid=melon --gid=melon \
  --property=EnvironmentFile=/etc/melon/web.env \
  --working-directory="$release_dir" \
  /usr/bin/npm run prod:check
```

最后原子更新当前 release 软链接：

```bash
sudo ln -sfn "$release_dir" /opt/melon/current
sudo chown -h root:root /opt/melon/current
```

## 安装和启动 systemd

从当前 release 安装所有 unit，先验证再启用：

```bash
sudo install -o root -g root -m 0644 /opt/melon/current/deploy/systemd/melon-web.service /etc/systemd/system/melon-web.service
sudo install -o root -g root -m 0644 /opt/melon/current/deploy/systemd/melon-preview-cleanup.service /etc/systemd/system/melon-preview-cleanup.service
sudo install -o root -g root -m 0644 /opt/melon/current/deploy/systemd/melon-preview-cleanup.timer /etc/systemd/system/melon-preview-cleanup.timer
sudo install -o root -g root -m 0644 /opt/melon/current/deploy/systemd/melon-upload-cleanup.service /etc/systemd/system/melon-upload-cleanup.service
sudo install -o root -g root -m 0644 /opt/melon/current/deploy/systemd/melon-upload-cleanup.timer /etc/systemd/system/melon-upload-cleanup.timer
sudo install -o root -g root -m 0644 /opt/melon/current/deploy/systemd/melon-trash-cleanup.service /etc/systemd/system/melon-trash-cleanup.service
sudo install -o root -g root -m 0644 /opt/melon/current/deploy/systemd/melon-trash-cleanup.timer /etc/systemd/system/melon-trash-cleanup.timer
sudo install -o root -g root -m 0644 /opt/melon/current/deploy/systemd/melon-auth-cleanup.service /etc/systemd/system/melon-auth-cleanup.service
sudo install -o root -g root -m 0644 /opt/melon/current/deploy/systemd/melon-auth-cleanup.timer /etc/systemd/system/melon-auth-cleanup.timer

sudo systemd-analyze verify \
  /etc/systemd/system/melon-web.service \
  /etc/systemd/system/melon-preview-cleanup.service \
  /etc/systemd/system/melon-preview-cleanup.timer \
  /etc/systemd/system/melon-upload-cleanup.service \
  /etc/systemd/system/melon-upload-cleanup.timer \
  /etc/systemd/system/melon-trash-cleanup.service \
  /etc/systemd/system/melon-trash-cleanup.timer \
  /etc/systemd/system/melon-auth-cleanup.service \
  /etc/systemd/system/melon-auth-cleanup.timer

sudo systemctl daemon-reload
sudo systemctl enable --now \
  melon-preview-cleanup.timer \
  melon-upload-cleanup.timer \
  melon-trash-cleanup.timer \
  melon-auth-cleanup.timer \
  melon-web.service
```

验证主站、定时器和最近日志：

```bash
sudo systemctl status melon-web.service --no-pager
sudo systemctl list-timers 'melon-*' --all
sudo journalctl -u melon-web.service --since '-10 min' --no-pager
curl --fail --silent --show-error http://127.0.0.1:3000/api/health/live
curl --fail --silent --show-error http://127.0.0.1:3000/api/health/ready
```

`live` 仅表示 Node.js 进程可响应；`ready` 还检查 PostgreSQL。图搜服务不可用不应令主站 readiness 失败。

## TLS 和代理信任边界

反向代理必须：

- 把所有 HTTP 请求重定向到 HTTPS，并使用受信证书终止 TLS。
- 作为公网访问 `127.0.0.1:3000` 的唯一入口；安全组和主机防火墙同时阻止公网直连 3000。
- 对 `X-Forwarded-For` 和 `X-Real-IP` 先删除客户端提供的值，再用代理看到的客户端地址覆盖，不能追加不可信值。
- 固定转发 `Host` 和 `X-Forwarded-Proto=https`，并限制请求体大小、慢连接和异常请求速率。
- 通过外部 HTTPS 地址复查 HSTS、CSP、`X-Frame-Options`、`X-Content-Type-Options` 和 `Referrer-Policy`。

只有上述覆盖规则和网络隔离都验证通过，`AUTH_TRUST_PROXY=true` 才可信。可以在代理主机上分别执行：

```bash
curl --head https://your-production-host.example/login
curl --fail --silent --show-error https://your-production-host.example/api/health/live
curl --fail --silent --show-error https://your-production-host.example/api/health/ready
```

## 日志、保留和告警

将 `melon-web`、四个 cleanup service、反向代理和 RDS 审计/错误日志转发到受控日志系统，保留至少 180 天（六个月）。日志平台必须限制访问并配置生命周期；任何日志都不得记录密码、`AUTH_SECRET`、AccessKey、STS token、内部 token、签名 URL、原始查询图片或图案源文件。

至少配置以下告警：

- `melon-web.service` 启动失败、反复重启、内存限制触发或 readiness 连续失败。
- 外部 HTTPS 5xx、延迟、证书到期和 `/api/health/live` 失败。
- PostgreSQL 连接、存储、备份、复制延迟及 RDS 快照失败。
- OSS 403/5xx、STS 签发失败和对象删除失败。
- 任一 cleanup service 非零退出，或 systemd timer 未处于 active、最近触发时间超过两个计划周期。
- 回收站持续 `deleting`、上传或预览清理持续 pending、登录限流清理长时间未执行。

定时器告警不得只看 timer 是否存在，还要监控对应 service 的最近退出状态：

```bash
systemctl is-active melon-preview-cleanup.timer melon-upload-cleanup.timer melon-trash-cleanup.timer melon-auth-cleanup.timer
systemctl show -p Result melon-preview-cleanup.service melon-upload-cleanup.service melon-trash-cleanup.service melon-auth-cleanup.service
journalctl -u 'melon-*-cleanup.service' --since '-2 days' --no-pager
```

## 回滚

发布前记录 `/opt/melon/current` 原目标。仅在新 release 失败且上一版本与已经执行的数据库结构兼容时回滚应用代码：

```bash
previous_release=/opt/melon/releases/20261022T160000Z
test -f "$previous_release/.next/standalone/server.js"
sudo ln -sfn "$previous_release" /opt/melon/current
sudo chown -h root:root /opt/melon/current
sudo systemctl restart melon-web.service
curl --fail --silent --show-error http://127.0.0.1:3000/api/health/ready
```

数据库迁移默认不回滚，也不手工删除新表或列。当前迁移必须保持向后兼容；若迁移造成不可接受的数据问题，停止写入并按已验证的 RDS 快照/逻辑备份恢复流程处理，由负责人明确批准恢复点。恢复数据库会丢失恢复点之后的写入，不能作为普通代码回滚步骤。

图搜发布失败时，先设回 `IMAGE_SEARCH_ENABLED=false` 并重启主站，再按图搜手册回滚服务和索引；不要为恢复主站而跳过数据库或 OSS 完整性检查。

## 发布完成检查单

- [ ] 目标提交通过 audit、单元、集成、类型、lint、build 和 E2E 门禁。
- [ ] RDS 快照、逻辑备份、校验和及隔离恢复演练均有记录。
- [ ] `npm run prod:check` 在目标环境输出 PASS。
- [ ] 迁移记录正确，主站 `live` 和 `ready` 的回环及 HTTPS 检查均通过。
- [ ] systemd unit 通过 `systemd-analyze verify`，四个 timer 已启用且运行时间合理。
- [ ] TLS、安全头、代理 IP 覆盖规则和端口隔离已验证。
- [ ] 日志保留为 180 天且告警已进行一次受控触发测试。
- [ ] ICP/公安备案只展示真实已取得的值。
- [ ] OSS、RAM、STS、ECS 实例角色和备份权限完成真实环境验证。
- [ ] 以图搜图保持关闭，直到 100 张真实图片门禁通过并设置发布批准标记。

## 概念套图上线与运行

此功能的发布门禁独立于主站和研究视觉。默认保持 `INSPIRATION_CONCEPT_IMAGES_ENABLED=false`、`INSPIRATION_CONCEPT_RELEASE_APPROVED=false`；既有产物的读取、分享和下载不依赖生成开关。主站 `/api/health/ready` 只检查原有主站依赖，不查询 worker 心跳。`prod:check` 检查发布配置，不要求在线 worker 或可连接的数据库；运行时另用 `inspiration:concept-status` 诊断。

### 配置与价格核对

在 root-only `/etc/melon/web.env` 中设置真实服务端值，不使用 `NEXT_PUBLIC_*`：

```dotenv
INSPIRATION_ENABLED=true
INSPIRATION_CONCEPT_IMAGES_ENABLED=false
INSPIRATION_CONCEPT_RELEASE_APPROVED=false
INSPIRATION_IMAGE_MODEL=qwen-image-3.0-pro
INSPIRATION_CONCEPT_WORKER_ID=concept-worker-production-1
DASHSCOPE_API_KEY=
DASHSCOPE_WORKSPACE_ID=
DASHSCOPE_OPENAI_BASE_URL=
DASHSCOPE_NATIVE_BASE_URL=
OSS_ADAPTER=real
```

两个 provider 地址须为同一 workspace 主机：`https://<workspace>.<region>.maas.aliyuncs.com/compatible-mode/v1` 和 `https://<workspace>.<region>.maas.aliyuncs.com/api/v1`。不要将北京价格推断为实际部署地域价格。启用前在实际 workspace/region 的控制台确认模型可用、配额、账户折扣、余额、计费项目与预算报警，并记录日期与审核人。

批准方案采用的北京挂牌价估算，仅供预算参考：最多三张参考图的套图共最多九次图片输入，`9 × 0.02 CNY = 0.18 CNY`；三张 Pro 2K 输出，`3 × 0.50 CNY = 1.50 CNY`；一套预计 `1.68 CNY`，不含重试、促销差异和存储/流量。以[阿里云百炼官方模型价格](https://help.aliyun.com/zh/model-studio/model-pricing)及当前账户实际价格为准。这些数字不进入应用计费逻辑。三张输出为草图、效果图和平面图；再次生成或重试可能追加计费。

本发布不假定或自动执行 ECS 升级。现有主机先核实剩余内存、CPU、磁盘、DB 连接与 OSS/RAM 权限；worker 上限 768M、cleanup 上限 512M，必须留出 web/PostgreSQL/图搜所需余量并观察真实峰值。容量不足时先停灰度、评估后单独批准扩容。

### 严格发布顺序

1. 保存数据库备份与隔离恢复演练证据，记录发布 SHA、恢复耗时和校验结果。
2. 生成开关保持 false，先执行 additive migration，再启动任何新 web 或 worker。通过前文 transient systemd 环境方式运行 `npm run db:migrate`；保留现有数据，不做 downgrade。迁移失败即停止发布。
3. 安装本版 web、worker、cleanup service/timer，执行目标 Linux 的 `systemd-analyze verify`，再 reload。macOS 开发环境通常没有 systemd；本地跳过不是目标机通过证据。
4. 仅在受控候选环境批准生成配置，启动 worker，检查空队列及新鲜心跳。生产公开 web 生成开关仍关闭。
5. 在受访问控制的候选 web（仅运维隧道/私有入口）为一个受控账户生成一套，使用至多三张参考图；确认先草图、后两个衍生图、输出尺寸与父子关系。不得用循环重试替代诊断。
6. 验证真实私有 OSS、owner/share 权限、撤销分享、下载 MIME/文件名、刷新/重开后显示、worker 在提交后重启能导入且不重复计费，以及账户账单的实际 workspace/region。保存脱敏验收记录。验收测试属于单独授权的真实 smoke 门禁，本运维安装不会自动调用 provider。
7. 门禁全部通过后，将生产 `INSPIRATION_CONCEPT_RELEASE_APPROVED=true`，保留其余核对过的配置，再将 `INSPIRATION_CONCEPT_IMAGES_ENABLED=true`，执行 `prod:check` 并重启 web/worker；先保持私邀范围，观察队列、账单和内存再扩大开放。

步骤 4–6 可使用隔离候选主机；若同机验证，公开 web 的 `/etc/melon/web.env` 中两个概念开关仍保持 false，worker 按下一节加载经批准的临时专用环境文件。候选 web 使用独立环境文件与仅回环端口。release approval 表示该受控运行已获准，不能替代真实验收结果。

按 [systemd 环境文件规则](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#EnvironmentFile=)，`EnvironmentFile=` 的值覆盖 `Environment=`，多个环境文件中后读的值覆盖先读的值。因此不能用 inline `Environment=true` 覆盖共享文件的 false。基础 worker unit 保持只加载共享文件；仅在明确安装下面的 drop-in 后追加专用文件，不在基础 unit 中隐式加载可选覆盖文件。

```bash
sudo install -o root -g root -m 0644 deploy/systemd/melon-inspiration-concept-worker.service /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/systemd/melon-inspiration-concept-cleanup.service /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/systemd/melon-inspiration-concept-cleanup.timer /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/melon-inspiration-concept-worker.service /etc/systemd/system/melon-inspiration-concept-cleanup.service /etc/systemd/system/melon-inspiration-concept-cleanup.timer
sudo systemctl daemon-reload
# worker 在下节验证完成后另行启动；此处不触发 provider 工作。
sudo systemctl enable --now melon-inspiration-concept-cleanup.timer
sudo systemctl status melon-inspiration-concept-worker.service melon-inspiration-concept-cleanup.timer
sudo systemctl list-timers melon-inspiration-concept-cleanup.timer
```

### Worker 临时开关、无请求验证与撤销

仅在受控运行或恢复已批准、迁移完成、共享文件其余配置有效后执行。共享文件仍提供数据库、凭据、模型、workspace 和显式 worker ID；临时文件只覆盖两个概念开关，不复制密钥。确认 `INSPIRATION_ENABLED=true` 等 worker 启动前提已满足。不要把整个 `optional/` 目录批量安装到所有服务。

以下命令从已审查的 release 根目录执行。先停止 worker；随后 `90-concept-worker-flags.conf` **追加** `/etc/melon/concept-worker-flags.env` 到原有 `/etc/melon/web.env` 之后，不清空 `EnvironmentFile=` 列表，不使用可选文件的 `-` 前缀。文件缺失时启动失败，避免悄悄回退到错误配置。环境文件为 root:root 0600，由 systemd 降权前读取。

```bash
sudo systemctl stop melon-inspiration-concept-worker.service
sudo install -o root -g root -m 0600 deploy/systemd/optional/concept-worker-flags.env /etc/melon/concept-worker-flags.env
sudo install -d -o root -g root -m 0755 /etc/systemd/system/melon-inspiration-concept-worker.service.d
sudo install -o root -g root -m 0644 deploy/systemd/optional/90-concept-worker-flags.conf /etc/systemd/system/melon-inspiration-concept-worker.service.d/90-concept-worker-flags.conf
sudo install -o root -g root -m 0644 deploy/systemd/optional/99-concept-worker-flags-check.conf /etc/systemd/system/melon-inspiration-concept-worker.service.d/99-concept-worker-flags-check.conf
sudo stat -c '%U %G %a %n' /etc/melon/concept-worker-flags.env /etc/systemd/system/melon-inspiration-concept-worker.service.d/90-concept-worker-flags.conf /etc/systemd/system/melon-inspiration-concept-worker.service.d/99-concept-worker-flags-check.conf
sudo systemd-analyze verify /etc/systemd/system/melon-inspiration-concept-worker.service
sudo systemctl daemon-reload
sudo systemctl show melon-inspiration-concept-worker.service -p EnvironmentFiles -p DropInPaths -p Type -p Restart -p ExecStart -p ExecStartPre -p ExecStartPost
```

必须核对 `EnvironmentFiles` 按共享文件、专用文件的顺序排列；drop-in 按文件名顺序合并，`90-` 追加环境文件，`99-` 只替换验证进程。若存在其他 drop-in 修改这些设置，先解决冲突。此时 Type 必须是 `oneshot`、Restart 是 `no`，唯一 ExecStart 必须是 `/usr/bin/node /opt/melon/current/scripts/check-inspiration-concept-worker-flags.mjs`，ExecStartPre/ExecStartPost 必须为空；否则不要 start。此脚本不加载 dotenv/应用模块、不连接数据库或 provider，直接读取 systemd 实际注入的环境，只输出两个布尔值。不要使用 `printenv`、`systemctl show -p Environment` 或打印 `/proc/.../environ` 来检查生产环境。

```bash
# 此时启动的是实际 worker unit 下的纯环境探针，不是生成 worker。
sudo systemctl start melon-inspiration-concept-worker.service
sudo systemctl show melon-inspiration-concept-worker.service -p Result -p ExecMainStatus
sudo journalctl -u melon-inspiration-concept-worker.service --since '5 minutes ago' --grep '^{"conceptImagesEnabled":' --output=cat --no-pager
```

要求 start 退出 0、Result=success、ExecMainStatus=0，最新探针输出恰为 `{"conceptImagesEnabled":true,"releaseApproved":true}`。验证失败时保持 probe 和公开 web 禁用状态，排查文件顺序、权限与冲突，不能启动真实 worker。该目标 Linux 的有效环境检查和 `systemd-analyze verify` 都是门禁；本地配置契约测试不能替代它们。

验证成功后，仅撤掉 `99-` 探针，reload 并检查恢复为 `Type=simple`、`Restart=on-failure` 和 `scripts/run-inspiration-concept-worker.ts`，再在受控运行批准范围内启动真实 worker：

```bash
sudo rm -- /etc/systemd/system/melon-inspiration-concept-worker.service.d/99-concept-worker-flags-check.conf
sudo systemctl daemon-reload
sudo systemctl show melon-inspiration-concept-worker.service -p EnvironmentFiles -p Type -p Restart -p ExecStart
sudo systemctl enable --now melon-inspiration-concept-worker.service
```

受控阶段结束、最终共享配置已统一，或回滚恢复完成后，先停止 worker，再按下列顺序撤销覆盖。明确删除本次安装的两个 drop-in，不删除其他运维配置；先移除引用并 reload，再删除环境文件：

```bash
sudo systemctl stop melon-inspiration-concept-worker.service
sudo rm -f -- /etc/systemd/system/melon-inspiration-concept-worker.service.d/99-concept-worker-flags-check.conf /etc/systemd/system/melon-inspiration-concept-worker.service.d/90-concept-worker-flags.conf
sudo systemctl daemon-reload
sudo rm -- /etc/melon/concept-worker-flags.env
sudo systemd-analyze verify /etc/systemd/system/melon-inspiration-concept-worker.service
sudo systemctl show melon-inspiration-concept-worker.service -p EnvironmentFiles -p DropInPaths -p Type -p Restart -p ExecStart
```

确认仅剩共享环境文件，探针/专用文件不再被引用。正常发布且共享开关已通过全部门禁设为 true 时才重新 start worker；回滚时共享生成开关为 false，保持 worker 停止。`daemon-reload` 不改变已经运行的进程环境，因此停止/重启步骤不可省略。

### 心跳、队列和失败诊断

```bash
sudo systemd-run --wait --pipe --collect --uid=melon --gid=melon \
  --property=EnvironmentFile=/etc/melon/web.env --working-directory=/opt/melon/current \
  /usr/bin/npm run inspiration:concept-status
sudo journalctl -u melon-inspiration-concept-worker.service -u melon-inspiration-concept-cleanup.service --since '30 minutes ago' --no-pager
sudo systemctl stop melon-inspiration-concept-worker.service
sudo systemctl start melon-inspiration-concept-worker.service
```

状态 JSON 仅含 `healthy`、`status`、`heartbeatAgeMs`、`counts.{queued,submitting,submitted,failed}` 和 `oldestQueueAgeMs`；心跳缺失/超过 90 秒或执行失败退出非零。查的是配置的 worker ID，不以另一个 worker 的心跳掩盖故障。队列计数排除 tombstone，failed 为保留记录总量，不代表本次新增；结合前后快照判断趋势。

心跳 stale/missing：检查 unit 是否运行、配置 worker ID 是否一致、DB 连接/时间同步及内存限制。queued/最老等待年龄持续增长：检查 worker 是否启动、模型/地域配额和网络；submitting 逾期属于不确定付费提交，恢复逻辑标记不确定失败，禁止人工盲目重复提交。submitted 持续增长：核对 provider 查询连通性、OSS 导入权限；单个任务总期限 30 分钟，先诊断稳定错误码。不要在公共日志、工单或截图中复制 DB URL、owner/task/provider IDs、提示词、对象键和签名 URL。

### 孤儿对象清理

禁止使用生命周期到期规则删除 `research/` 或 `concept-sets/` 已完成对象：保留的概念引用可能长期用于衍生重试，数据库 pin 无法阻止 OSS 自动过期。候选与生产 bucket 均必须核验没有更广的 bucket/前缀规则使 `research/` 或 `concept-sets/` 到期；未核验不得启用。被新任务取代且无引用的研究键只由引用感知应用清理删除；报告删除由无级联外键的持久清理 manifest 记录精确研究范围和集合 IDs，定时清理完成后才移除 manifest。不要用未实现的对象标签规则代替此门禁。

每日 03:20 加最多 45 分钟随机延迟，`Persistent=true` 会在主机错过时补跑。服务读取 `/etc/melon/web.env`，oneshot 最长 15 分钟；程序在开始新项目前检查 10 分钟预算。只扫描数据库授权的集合前缀及持久 manifest 记录的精确报告 research 前缀、concept-set 前缀，每次至多 25 个集合、25 个研究对象键和 25 份报告 manifest；每个前缀至多十页/10,000 个对象；异常大前缀失败并保留数据，需单独排查，不使用全 bucket 删除。

集合必须是删除态或终态且超过 24 小时，终态必须同时满足更新时间和完成时间；对象本身也须超过 24 小时。queued/generating、当前输出、有效任务租约、有效删除租约、图库对象和新写入都受到保护。成功扫描的终态更新时间向后移动，避免批次始终卡在相同的前 25 个集合。失败保留可重试记录；先解决失败原因再补跑，重复失败项可能拖慢积压清理。

研究证据必须被较新的已完成研究任务取代至少 24 小时，所有同键别名均无存活引用关系、不是当前/处理中研究任务，并通过对象元数据年龄检查。tombstone 的引用仍保留，直到该集合完成对象删除并硬清理后才释放。研究删除需逐键 OSS 确认；失败不删除数据库记录。

报告删除的 manifest 在事务内创建，analysis/user BEFORE DELETE 触发器在旧版本或用户级级联前补齐精确集合 IDs；manifest 无 FK，级联不删除它。满 24 小时后清理先提交 30 分钟租约，逐前缀校验键与年龄、逐键确认删除并再次列举；所有记录范围为空且 exact token/until 仍有效才移除 manifest。新对象、图库/存活别名继续保护。失败释放原租约，进程退出/DB 故障后租约到期可重领；dry-run 只读取/列举且不领取租约。存活报告的清理仍持有分析/集合数据库锁防止同时发布或新增引用，可能短暂阻塞同一分析的编辑/重试。

```bash
# 先只读演练：没有 DB 更新、租约写入、对象删除。
sudo systemd-run --wait --pipe --collect --uid=melon --gid=melon \
  --property=EnvironmentFile=/etc/melon/web.env --working-directory=/opt/melon/current \
  /usr/bin/npm run inspiration:concept-cleanup -- --dry-run
# 核对范围和固定摘要后执行 live；只接受无参数或 --dry-run。
sudo systemd-run --wait --pipe --collect --uid=melon --gid=melon \
  --property=EnvironmentFile=/etc/melon/web.env --working-directory=/opt/melon/current \
  /usr/bin/npm run inspiration:concept-cleanup
sudo systemctl start melon-inspiration-concept-cleanup.service
sudo systemctl status melon-inspiration-concept-cleanup.service
```

摘要仅包含 dryRun、扫描/跳过/删除计数和 failures；dry-run 的删除计数为零，不模拟删除后的引用释放。`failures > 0` 或异常退出非零；不输出对象键和原始错误。若 OSS 已删而 DB 提交失败，下次幂等重试，绝不因清理失败把记录标记完成。清理可在 UI 生成开关关闭时运行，但事故回滚期间先停 timer，保留待排查资料。

### 概念功能回滚

先把公开 web 的 `INSPIRATION_CONCEPT_IMAGES_ENABLED=false` 并重启 web，阻止新创建/重试。已提交任务可继续由尚运行的 worker 完成导入；worker 只在启动时读取 env，关闭 web 开关不会主动终止它。保持监控直到 submitting/submitted 清空，再停止 worker。如果不能安全等待，则在受限事故记录中登记待处理数量和必要关联信息，然后停止 worker，后续按持久状态恢复，不重新提交不确定任务。

```bash
sudo systemctl stop melon-inspiration-concept-cleanup.timer
# 等待导入结束，或已记录待恢复状态后：
sudo systemctl stop melon-inspiration-concept-worker.service
sudo systemctl disable melon-inspiration-concept-worker.service
```

需要重启 worker 恢复导入时，保持公开 web 生成开关 false，完整执行上文「Worker 临时开关、无请求验证与撤销」中的专用文件创建（root:root 0600）、`90-` 追加文件与 `99-` 探针安装、Linux verify/reload/有效标志检查；通过后撤掉探针、reload，再启动已批准的真实 worker。worker 没有“仅导入”模式，也可能处理已有 queued 任务；若不批准这些任务继续提交，应登记状态并保持停止。恢复完成后执行该节的停止、移除 drop-in、daemon-reload、删除专用文件及检查命令，确认仅加载共享文件且保持 worker 停止。不要使用 inline `Environment=` 代替这套文件顺序。必要时停止正在执行的 cleanup service（未完成事务回滚，下次可重试），然后切回上一 web release。必须保留 0013 additive manifest 表、analysis/user BEFORE DELETE 触发器及 NO ACTION DEFERRABLE INITIALLY DEFERRED 引用 FK；旧 web 仍能直接删除报告并留下精确 cleanup manifest。必须使用兼容版本的 cleanup binary/timer（独立保留新版本 release 目录并让清理服务指向它），或明确记录暂缓清理并保留 manifests，待下一次兼容发布恢复处理；不能让旧 cleanup binary 被误认为可消费新 manifests。保留 additive 表、任务记录、引用、已完成 OSS 产物以及已有分享/下载数据；事故期间绝不执行破坏性降级 SQL、全 bucket 清理或删除既有输出。回滚前版本若不显示新概念卡片，数据仍保留供修复后恢复展示。

### 概念套图 Task 11 发布验收记录要求

先完成下列离线门禁；它们不启动生成 worker、不访问真实 provider/OSS、不产生费用：

```bash
npm test -- src/features/inspiration-concepts src/features/inspiration src/features/inspiration-visuals 'src/app/api/inspiration-analyses/[analysisId]/concept-sets' 'src/app/api/inspiration-concept-assets' 'src/app/(share)/share/inspiration/[shareId]/assets/[assetId]/route.test.ts' scripts/run-inspiration-concept-worker.test.ts scripts/cleanup-inspiration-concept-objects.test.ts scripts/check-inspiration-concept-worker.test.ts scripts/check-production.test.ts
npm run test:integration -- src/lib/db/schema/inspiration-concepts.integration.test.ts src/features/inspiration-concepts/service.integration.test.ts src/features/inspiration-concepts/worker.integration.test.ts src/features/inspiration-concepts/resource-service.integration.test.ts src/features/inspiration-concepts/cleanup.integration.test.ts src/features/inspiration/share-service.integration.test.ts src/features/inspiration/analysis-service.integration.test.ts
npm run typecheck
npm run lint
npm run build
E2E_METADATA_ONLY=1 npm run test:e2e -- tests/e2e/inspiration-concepts.spec.ts --project=chromium
npm run test:e2e:concepts-disabled
git diff --check
```

概念 E2E 默认仅使用端口 3214、`melon_concepts_e2e` 隔离测试库（可通过 `E2E_PORT`、`E2E_DATABASE_URL` 覆盖，库名必须以 `_e2e` 结尾），metadata-only 模式包含直接调用 spec 的子进程。不要复用生产数据库，不要启动真实 worker。测试专用虚拟 provider/OSS 配置不得复制到生产。测试前后删除该报告的套图记录再清理报告，遵守参考资产 FK，不放宽鉴权。所有浏览器外部请求都被拦截并视为失败。图片与下载为同源拦截本地字节；这证明 UI 渲染与链接契约，真实存储字节需以下外部门禁确认。

截图覆盖 owner/shared 的 1512×982、1440×900、768×1024、390×844，需人工检查 `test-results/concepts-enabled/` 与 `test-results/concepts-disabled/` 中代表性的 completed、partial、drawer 和 output-dialog 图片。共享页面对 queued/partial/retrying 仅展示已完成输出，不展示控制与私有字段；无完成图时不展示任务占位。保存截图到受控验收附件后再运行同一模式的后续 Playwright（对应输出会重建）。

以下门禁当前仍为 **待执行**，不得把本地离线结果写成生产/真实计费通过：

1. 目标 Linux 上完整执行前文 systemd verify、环境文件顺序和无网络探针，确认 web readiness 不依赖 worker 存活；macOS 本地测试不替代该证据。
2. 另获明确计费授权后执行 `RUN_REAL_INSPIRATION_CONCEPT_TESTS=1 npm run test:inspiration:concept-real`。最多三次 paid create，24 次/阶段有界查询，无自动重新提交；验证三张尺寸正确的 PNG、私有 OSS 导入及 finally 删除。固定失败码包括清理失败；失败后停止，诊断后重新授权，不能循环重跑。测试不输出可定位 smoke 对象的 ID/key，运维应依赖受控 bucket 审计确认清理，不能公开原始 provider/OSS 日志。
3. 代码以两个概念开关 false 部署；在隔离且已获批准的候选入口/worker 配置中，由一个内部账户只创建一套。草图提交后重启 worker，确认不重复提交/计费、两张衍生图仍完成。检查三张 durable asset、3:4/3:4/4:3、至多三输入、父草图与首两张参考的顺序、owner/download/share 私有字节响应、撤销和跨租户 404、删除清理、关闭开关后的历史可读、worker 状态、脱敏日志及实际 DashScope workspace 账单。
4. 保存发布 SHA、执行时间、数量/费用和通过/失败结论，绝不记录提示词、凭据、provider IDs、URL、对象键、Base64 或私人内容。任一门禁未通过，公开 web 保持 `INSPIRATION_CONCEPT_IMAGES_ENABLED=false`、`INSPIRATION_CONCEPT_RELEASE_APPROVED=false`；全部通过后才按前文严格发布顺序启用。

新隔离工作树没有 `.env.local` 时，原样 build 会因缺少必填服务端配置失败。离线制品验证可以仅为这一次进程注入下面的非秘密占位配置，仍保留 schema 校验和 false 发布开关；这不是生产配置或上线批准：

```bash
DATABASE_URL=postgres://melon:melon@127.0.0.1:55432/melon_concepts_e2e \
AUTH_SECRET=offline-build-secret-at-least-32-characters APP_ORIGIN=http://127.0.0.1:3214 \
ALIYUN_OSS_REGION=oss-cn-hangzhou ALIYUN_OSS_BUCKET=metadata-e2e-no-assets \
ALIYUN_OSS_ENDPOINT=https://assets.example.test ALIYUN_OSS_CNAME=true \
ALIYUN_STS_ROLE_ARN=acs:ram::123456789012:role/test-only \
INSPIRATION_ENABLED=false INSPIRATION_CONCEPT_IMAGES_ENABLED=false \
INSPIRATION_CONCEPT_RELEASE_APPROVED=false INSPIRATION_WEB_VISUALS_ENABLED=false \
IMAGE_SEARCH_ENABLED=false npm run build
```
