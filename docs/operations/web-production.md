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
sudo install -o root -g root -m 0644 /opt/melon/current/deploy/systemd/melon-trash-cleanup.service /etc/systemd/system/melon-trash-cleanup.service
sudo install -o root -g root -m 0644 /opt/melon/current/deploy/systemd/melon-trash-cleanup.timer /etc/systemd/system/melon-trash-cleanup.timer
sudo install -o root -g root -m 0644 /opt/melon/current/deploy/systemd/melon-auth-cleanup.service /etc/systemd/system/melon-auth-cleanup.service
sudo install -o root -g root -m 0644 /opt/melon/current/deploy/systemd/melon-auth-cleanup.timer /etc/systemd/system/melon-auth-cleanup.timer

sudo systemd-analyze verify \
  /etc/systemd/system/melon-web.service \
  /etc/systemd/system/melon-preview-cleanup.service \
  /etc/systemd/system/melon-preview-cleanup.timer \
  /etc/systemd/system/melon-trash-cleanup.service \
  /etc/systemd/system/melon-trash-cleanup.timer \
  /etc/systemd/system/melon-auth-cleanup.service \
  /etc/systemd/system/melon-auth-cleanup.timer

sudo systemctl daemon-reload
sudo systemctl enable --now \
  melon-preview-cleanup.timer \
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

将 `melon-web`、三个 cleanup service、反向代理和 RDS 审计/错误日志转发到受控日志系统，保留至少 180 天（六个月）。日志平台必须限制访问并配置生命周期；任何日志都不得记录密码、`AUTH_SECRET`、AccessKey、STS token、内部 token、签名 URL、原始查询图片或图案源文件。

至少配置以下告警：

- `melon-web.service` 启动失败、反复重启、内存限制触发或 readiness 连续失败。
- 外部 HTTPS 5xx、延迟、证书到期和 `/api/health/live` 失败。
- PostgreSQL 连接、存储、备份、复制延迟及 RDS 快照失败。
- OSS 403/5xx、STS 签发失败和对象删除失败。
- 任一 cleanup service 非零退出，或 systemd timer 未处于 active、最近触发时间超过两个计划周期。
- 回收站持续 `deleting`、预览清理持续 pending、登录限流清理长时间未执行。

定时器告警不得只看 timer 是否存在，还要监控对应 service 的最近退出状态：

```bash
systemctl is-active melon-preview-cleanup.timer melon-trash-cleanup.timer melon-auth-cleanup.timer
systemctl show -p Result melon-preview-cleanup.service melon-trash-cleanup.service melon-auth-cleanup.service
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
- [ ] systemd unit 通过 `systemd-analyze verify`，三个 timer 已启用且运行时间合理。
- [ ] TLS、安全头、代理 IP 覆盖规则和端口隔离已验证。
- [ ] 日志保留为 180 天且告警已进行一次受控触发测试。
- [ ] ICP/公安备案只展示真实已取得的值。
- [ ] OSS、RAM、STS、ECS 实例角色和备份权限完成真实环境验证。
- [ ] 以图搜图保持关闭，直到 100 张真实图片门禁通过并设置发布批准标记。
