# 阿里云 OSS 运行配置

本文只描述 `melon` 的 OSS 安全边界和上线检查。最后核对日期：2026-10-20。阿里云控制台名称可能调整；权限含义以本文链接的官方文档为准。

## 访问模型

Bucket 必须是 `melon` 专用的私有 Bucket。浏览器不持有长期 AccessKey，也不能读取、列举或删除对象：

1. 已登录浏览器向同源 Next.js API 初始化上传。
2. 服务端先验证当前账号和图案归属，再用默认凭证提供链调用 STS `AssumeRole`。
3. 每次签发 900 秒临时凭证，并用 session policy 限制到当前用户、当前图案的唯一前缀。STS 返回的 expiration 必须是 UTC `Z` 结尾的规范 ISO-8601 时间，且至少晚于服务端当前时间 30 秒；否则拒绝凭证响应。
4. 浏览器使用临时凭证直传 OSS。上传完成后，服务端通过 `HEAD` 和 Range GET 验证对象。
5. 预览和下载只由服务端完成归属校验后生成短期 OSS V4 签名 GET URL。签名 URL 不入库、不写日志。

对象键只允许以下两种规范结构，其中所有 ID 都是 UUID，扩展名固定为小写：

```text
users/{OWNER_UUID}/patterns/{PATTERN_UUID}/source/{ASSET_UUID}.{psd|ai|pdf|jpg|jpeg|png|procreate}
users/{OWNER_UUID}/patterns/{PATTERN_UUID}/derived/{ASSET_UUID}.{jpg|jpeg|png|webp}
```

`source` 保存原始资产，只接受产品批准的原文件格式（包括 PDF）；`derived` 保存 preview 和 thumbnail 等派生资产，只接受 JPG、PNG 或 WebP 图像。WebP 仅允许用于派生资产，不能声明为 source。派生角色由数据库记录和调用方区分，不编码进对象键。每个派生对象必须使用自己的资产 UUID；preview 和 thumbnail 禁止复用同一资产 UUID，否则会解析为同一个 OSS key。应用使用 `assertDistinctDerivedAssetIds` 在生成这两个派生键前验证这一约束。对象键不包含邮箱、用户名、图案名或原始文件名。

生成对象键、STS policy 和归属校验时，合法 UUID 输入会先规范为与 PostgreSQL `uuid` 文本输出一致的小写形式。解析已存在的对象键时不做宽松修复：只接受完整的小写规范 key，大写 UUID 或其他等价写法一律 fail closed。这样数据库值、policy resource 与归属比较只有一种文本表示。

## Bucket 基线

在 OSS 控制台完成以下设置：

- ACL 设为 `private`，保持 Block Public Access 开启；对象 ACL 使用继承 Bucket 的默认值，不创建公开对象。参见[OSS 权限与访问控制概览](https://www.alibabacloud.com/help/en/oss/user-guide/permissions-and-access-control-overview)。
- 开启 Bucket 默认服务端加密。当前方案使用 SSE-OSS / AES256；它不需要把 KMS 权限加入浏览器角色。注意 Bucket 默认加密只覆盖启用后写入的对象。参见[OSS 服务端加密](https://www.alibabacloud.com/help/en/oss/user-guide/server-side-encryption-8)。
- 版本控制保持关闭（`Disabled`，不要先启用再暂停）。当前删除接口只按 key 删除；若未来开启版本控制，必须先扩展接口以列举并按 `versionId` 永久删除对象版本和 delete marker，并补充 `oss:DeleteObjectVersion` 权限。参见[OSS 版本控制](https://www.alibabacloud.com/help/en/oss/user-guide/overview-78/)和[管理版本对象](https://www.alibabacloud.com/help/en/oss/user-guide/manage-objects-in-a-versioning-enabled-bucket)。
- 应用和 Bucket 使用同一地域。`ALIYUN_OSS_REGION`、Bucket 所在地域和 endpoint 必须一致。
- 不开启静态网站托管，也不允许匿名访问。

## CORS

为每个实际部署环境单独创建 CORS 规则。`AllowedOrigin` 必须等于该环境的 `APP_ORIGIN`，包含协议、域名以及非默认端口；不要使用 `*`。本地开发和生产使用两条独立规则，例如 `http://localhost:3000` 与 `https://app.example.com`。

浏览器 multipart 流程所需规则：

| 配置项 | 值 |
| --- | --- |
| Allowed origins | 精确的 `APP_ORIGIN` |
| Allowed methods | `GET`, `HEAD`, `PUT`, `POST`, `DELETE` |
| Allowed headers | `authorization`, `content-type`, `content-md5`, `x-oss-date`, `x-oss-security-token`, `x-oss-content-sha256`, `x-oss-forbid-overwrite`, `x-oss-user-agent` |
| Exposed headers | `ETag`, `x-oss-request-id` |
| Max age | `600` 秒 |

`GET` 只用于带 UploadId 的 `ListParts`；`HEAD` 允许浏览器或 SDK 发起对象元数据、缓存和上传结果校验请求。服务端上传完成校验也使用 `HEAD`，但服务端到 OSS 的请求不受浏览器 CORS 约束。CORS 只允许浏览器发送这些方法，本身不授予 `GetObject`，浏览器 STS 策略仍然没有读取权限。`PUT` 上传 part，`POST` 初始化和完成 multipart，`DELETE` 放弃 multipart。上线前从实际浏览器抓取一次预检请求；若 SDK 版本新增请求头，只将确认需要的头加入规则，不扩大为通配符。参见[OSS CORS 官方配置说明](https://www.alibabacloud.com/help/en/oss/user-guide/configure-cross-origin-resource-sharing)和[Browser.js 临时授权](https://www.alibabacloud.com/help/en/oss/developer-reference/authorize-access-6)。

## 中国大陆自定义域名

对于受 2025-03-20 规则影响的新 OSS 用户，中国大陆地域 Bucket 的数据 API 不能继续使用默认公网 endpoint，必须绑定自定义域名。配置要求：

- 域名完成适用的 ICP 备案并 CNAME 到该 Bucket。
- 自定义域名绑定有效 SSL 证书，只通过 HTTPS 使用。
- `ALIYUN_OSS_ENDPOINT=https://assets.example.com`。
- `ALIYUN_OSS_CNAME=true`。
- CORS 的 origin 仍是 Web 应用的精确 origin，不是 OSS 域名。

`ALIYUN_OSS_ENDPOINT` 只接受 HTTPS origin，即 hostname 和可选 port；显式 port 必须在 `1..65535`，不接受 port `0`。当前 `ali-oss` 6.23 客户端构造不支持 IPv6 literal endpoint，因此也拒绝 `[::1]` 这类地址。配置同时拒绝 userinfo、path、query 和 fragment。不要在未绑定证书时把 endpoint 降级为 HTTP。参见[OSS 访问域名与网络概览](https://www.alibabacloud.com/help/en/oss/user-guide/access-and-network-overview)和[绑定自定义域名](https://www.alibabacloud.com/help/en/oss/user-guide/access-buckets-via-custom-domain-names)。

## 浏览器上传角色

创建专用角色 `melon-browser-upload`。该角色只服务浏览器上传，不授予读取、Bucket 列举、对象列举、对象删除或管理权限。服务端每次 `AssumeRole` 都附带如下 session policy，`BUCKET` 和 UUID 由服务端验证后填写：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "oss:AbortMultipartUpload",
        "oss:ListParts",
        "oss:PutObject"
      ],
      "Resource": "acs:oss:*:*:BUCKET/users/OWNER_UUID/patterns/PATTERN_UUID/*"
    }
  ]
}
```

权限保持这三项的原因：

- `oss:PutObject` 同时覆盖 InitiateMultipartUpload、UploadPart 和 CompleteMultipartUpload。
- `oss:ListParts` 只用于断点续传时查询当前 UploadId 已完成的 part。
- `oss:AbortMultipartUpload` 只用于用户明确放弃上传时回收 part。

不要添加通配 action，也不要添加 `GetObject`、`ListObjects`、`ListMultipartUploads` 或额外 Bucket 权限。阿里云的[Multipart upload API 权限表](https://www.alibabacloud.com/help/en/oss/user-guide/multipart-upload)明确给出了 API 到 RAM action 的映射。

角色本身的固定权限是 session policy 的上限，两者取交集。固定权限也只能覆盖 `melon` 专用 Bucket 的应用对象树和上述三项 action；不要复用其他应用的 OSS 角色。角色信任策略只信任下面的本地专用 RAM 身份和生产 ECS 实例角色。

## 服务端运行身份

服务端权限与浏览器角色分离。Next.js 服务端需要：

- 对目标上传角色的精确 `sts:AssumeRole` 权限。
- 对 `melon` 对象树的 `oss:GetObject`，用于 `HEAD`、Range 验证和签名 GET。
- 对同一对象树的 `oss:DeleteObject`，用于批量回收确认删除的资产。
- 对 Bucket 的 `oss:ListObjects`，并通过 `oss:Prefix` 条件只允许列举 `users/*/patterns/*`。永久删除会先列举图案前缀，以覆盖尚未写入数据库的在途或派生对象。

对象权限和列举权限必须分成不同 statement。`ListObjects` 是 Bucket 级操作，其 `Resource` 必须是 Bucket ARN；对象级 `GetObject` 和 `DeleteObject` 仍只覆盖 `BUCKET/users/*/patterns/*`：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Sid": "ListMelonObjects",
      "Effect": "Allow",
      "Action": "oss:ListObjects",
      "Resource": "acs:oss:*:*:BUCKET",
      "Condition": {
        "StringLike": {
          "oss:Prefix": "users/*/patterns/*"
        }
      }
    },
    {
      "Sid": "ReadAndDeleteMelonObjects",
      "Effect": "Allow",
      "Action": [
        "oss:GetObject",
        "oss:DeleteObject"
      ],
      "Resource": "acs:oss:*:*:BUCKET/users/*/patterns/*"
    }
  ]
}
```

`HeadObject` 对应 `oss:GetObject`，`ListObjectsV2` 对应 `oss:ListObjects`，`DeleteMultipleObjects` 对应 `oss:DeleteObject`；参见[HeadObject 权限](https://www.alibabacloud.com/help/en/oss/developer-reference/headobject)、[按前缀限制 ListObjects 权限](https://www.alibabacloud.com/help/en/oss/user-guide/access-control-base-on-ram-policy)、[DeleteMultipleObjects 权限和单请求 1000 对象上限](https://www.alibabacloud.com/help/en/oss/developer-reference/deletemultipleobjects)和[签名下载权限](https://www.alibabacloud.com/help/en/oss/user-guide/how-to-obtain-the-url-of-a-single-object-or-the-urls-of-multiple-objects)。适配器会验证返回 key 和完整删除列表均属于请求的规范图案前缀，再按最多 1000 个对象分块删除。多个分块请求不是事务：如果后续批次失败，早先批次可能已经完成。在上述版本控制保持关闭的基线下，调用方可重新列举并重试，已经删除的 key 可以安全重复提交；版本控制开启或暂停的 Bucket 不满足这项契约。服务端身份不需要 `oss:ListBuckets`、Bucket 根前缀列举或其他 OSS 管理权限。

以图搜图的局部特征对象位于同一规范图案树的 `derived/search/{INDEX_VERSION}/{PREVIEW_HASH}.npz`。只有使用 ECS 实例 RAM 角色的 Python API、worker 和清理命令可以读写该路径。不要修改浏览器上传角色的 action 集合，也不要为浏览器增加搜索特征的读取、列举或删除权限；ready 文档的发布仍由数据库 owner 外键和 worker 租约共同约束。

### 本地开发

创建专用 RAM 调用者，例如 `melon-local-sts-caller`，只允许它对 `melon-browser-upload` 角色执行 `sts:AssumeRole`，并按上面的服务端对象权限授予测试 Bucket 范围。不要给它允许假设所有角色的系统策略。

SDK 使用阿里云默认凭证提供链。通过阿里云 CLI 的独立 profile 或本机 `.env.local` 提供该专用身份；`.env.local` 已被 Git 忽略。不要把 AccessKey 写入源码、提交记录、文档、截图、聊天或浏览器环境变量，也不要使用阿里云主账号 AccessKey。参见[Node.js 默认凭证提供链](https://www.alibabacloud.com/help/en/sdk/developer-reference/v2-manage-node-js-access-credentials)和[限制角色假设范围](https://www.alibabacloud.com/help/en/ram/user-guide/assume-a-ram-role)。

### 生产 ECS

给 ECS 实例绑定专用实例 RAM 角色，并把相同的最小服务端权限附加到该实例角色。生产环境不配置长期 AccessKey；默认凭证提供链从 ECS 实例元数据取得并刷新临时凭证。启用 IMDSv2/安全强化模式，并限制实例角色只能假设 `melon-browser-upload`。参见[为 ECS 实例绑定 RAM 角色](https://www.alibabacloud.com/help/en/ecs/user-guide/attach-an-instance-ram-role-to-an-ecs-instance)。

## Multipart 生命周期

Multipart part 不会自行过期。创建启用状态的生命周期规则：

- 前缀：`users/`
- 动作：清理未完成的 multipart upload
- 期限：最后修改后 7 天

该规则只回收未完成 part，不在此规则中自动删除已完成对象。应用仍会在用户明确放弃时调用 abort；生命周期规则是断网、进程退出或 abort 失败时的兜底。参见[OSS 生命周期概览](https://www.alibabacloud.com/help/en/oss/user-guide/overview-54/)和[基于最后修改时间的生命周期规则](https://www.alibabacloud.com/help/en/oss/user-guide/lifecycle-rules-based-on-the-last-modified-time)。

## 手动预览清理

手动 JPG/PNG 封面会在浏览器中生成至多 2048 px 的预览和 512 px 的缩略图，并使用普通 `PutObject` 上传，不创建 multipart part。该次 STS session policy 只允许初始化返回的两个精确 derived object key，不能写 source 或当前预览对象。

上传取消、完成校验失败以及旧预览替换后的删除失败都会把待清理 key 持久化到 operation。即使取消时的即时删除已经成功，上传租约也会保留到 STS 凭证过期并经过在途写入缓冲期；清理命令随后会再次幂等删除同一组 key，防止迟到的 `PutObject` 重新留下孤立对象。它也会接管进程退出后遗留的初始化或验证状态。生产环境应每 5 分钟执行一次：

```bash
npm run preview:cleanup
```

命令可幂等重试；仍有 OSS 删除失败时以非零状态退出，便于 systemd timer 或监控告警。永久删除也会按图案前缀做最终兜底清理。

## 应用环境变量

只填写资源标识和连接信息，示例值不是可用凭证：

```dotenv
ALIYUN_OSS_REGION=oss-cn-hangzhou
ALIYUN_OSS_BUCKET=replace-with-dedicated-private-bucket
ALIYUN_OSS_ENDPOINT=https://assets.example.com
ALIYUN_OSS_CNAME=true
ALIYUN_STS_ROLE_ARN=acs:ram::123456789012:role/melon-browser-upload
OSS_ADAPTER=real
```

`OSS_ADAPTER=fake` 只能在自动化测试且 `NODE_ENV=test` 时使用。任何服务端错误日志都不得包含 AccessKey secret、security token、session policy 完整响应或签名 URL。

## 上线核对

- Bucket 和对象均不可匿名读取。
- SSE-OSS/AES256 已启用，并用新上传对象确认响应头。
- Bucket 版本控制保持关闭，状态为 `Disabled`。
- 生产和开发 CORS 都是精确 origin，无通配 origin/header。
- 中国大陆受影响账号的自定义域名、ICP 和 HTTPS 证书均生效。
- 浏览器 STS 有效期为 900 秒；源文件上传只覆盖当前 owner/pattern 前缀，手动预览只覆盖本次两个精确 derived key，二者都只有三项写入 action。
- 浏览器凭证不能读取对象、列举 Bucket、访问其他图案或其他用户前缀。
- 本地 RAM 调用者和 ECS 实例角色只能假设指定上传角色。
- 本地 RAM 调用者和 ECS 实例角色能以 `users/*/patterns/*` 下的图案前缀调用 `ListObjectsV2`，但不能列举 Bucket 根前缀或图案树以外的对象；对象读取和删除仍只能访问 `BUCKET/users/*/patterns/*`。
- 7 天未完成 multipart 生命周期规则已启用。
- 应用日志和数据库中没有长期密钥、security token 或签名 URL。
