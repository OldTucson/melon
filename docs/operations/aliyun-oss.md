# 阿里云 OSS 运行配置

本文只描述 `melon` 的 OSS 安全边界和上线检查。最后核对日期：2026-10-09。阿里云控制台名称可能调整；权限含义以本文链接的官方文档为准。

## 访问模型

Bucket 必须是 `melon` 专用的私有 Bucket。浏览器不持有长期 AccessKey，也不能读取、列举或删除对象：

1. 已登录浏览器向同源 Next.js API 初始化上传。
2. 服务端先验证当前账号和图案归属，再用默认凭证提供链调用 STS `AssumeRole`。
3. 每次签发 900 秒临时凭证，并用 session policy 限制到当前用户、当前图案的唯一前缀。
4. 浏览器使用临时凭证直传 OSS。上传完成后，服务端通过 `HEAD` 和 Range GET 验证对象。
5. 预览和下载只由服务端完成归属校验后生成短期 OSS V4 签名 GET URL。签名 URL 不入库、不写日志。

对象键只允许以下规范结构，其中所有 ID 都是 UUID，扩展名固定为小写：

```text
users/{OWNER_UUID}/patterns/{PATTERN_UUID}/{source|preview|thumbnail}/{ASSET_UUID}.{psd|ai|jpg|jpeg|png|procreate}
```

对象键不包含邮箱、用户名、图案名或原始文件名。

## Bucket 基线

在 OSS 控制台完成以下设置：

- ACL 设为 `private`，保持 Block Public Access 开启；对象 ACL 使用继承 Bucket 的默认值，不创建公开对象。参见[OSS 权限与访问控制概览](https://www.alibabacloud.com/help/en/oss/user-guide/permissions-and-access-control-overview)。
- 开启 Bucket 默认服务端加密。当前方案使用 SSE-OSS / AES256；它不需要把 KMS 权限加入浏览器角色。注意 Bucket 默认加密只覆盖启用后写入的对象。参见[OSS 服务端加密](https://www.alibabacloud.com/help/en/oss/user-guide/server-side-encryption-8)。
- 应用和 Bucket 使用同一地域。`ALIYUN_OSS_REGION`、Bucket 所在地域和 endpoint 必须一致。
- 不开启静态网站托管，也不允许匿名访问。

## CORS

为每个实际部署环境单独创建 CORS 规则。`AllowedOrigin` 必须等于该环境的 `APP_ORIGIN`，包含协议、域名以及非默认端口；不要使用 `*`。本地开发和生产使用两条独立规则，例如 `http://localhost:3000` 与 `https://app.example.com`。

浏览器 multipart 流程所需规则：

| 配置项 | 值 |
| --- | --- |
| Allowed origins | 精确的 `APP_ORIGIN` |
| Allowed methods | `GET`, `PUT`, `POST`, `DELETE` |
| Allowed headers | `authorization`, `content-type`, `content-md5`, `x-oss-date`, `x-oss-security-token`, `x-oss-content-sha256`, `x-oss-forbid-overwrite`, `x-oss-user-agent` |
| Exposed headers | `ETag`, `x-oss-request-id` |
| Max age | `600` 秒 |

`GET` 只用于带 UploadId 的 `ListParts`；CORS 本身不授予 `GetObject`。`PUT` 上传 part，`POST` 初始化和完成 multipart，`DELETE` 放弃 multipart。上线前从实际浏览器抓取一次预检请求；若 SDK 版本新增请求头，只将确认需要的头加入规则，不扩大为通配符。参见[OSS CORS 官方配置说明](https://www.alibabacloud.com/help/en/oss/user-guide/configure-cross-origin-resource-sharing)和[Browser.js 临时授权](https://www.alibabacloud.com/help/en/oss/developer-reference/authorize-access-6)。

## 中国大陆自定义域名

对于受 2025-03-20 规则影响的新 OSS 用户，中国大陆地域 Bucket 的数据 API 不能继续使用默认公网 endpoint，必须绑定自定义域名。配置要求：

- 域名完成适用的 ICP 备案并 CNAME 到该 Bucket。
- 自定义域名绑定有效 SSL 证书，只通过 HTTPS 使用。
- `ALIYUN_OSS_ENDPOINT=https://assets.example.com`。
- `ALIYUN_OSS_CNAME=true`。
- CORS 的 origin 仍是 Web 应用的精确 origin，不是 OSS 域名。

不要在未绑定证书时把 endpoint 降级为 HTTP。参见[OSS 访问域名与网络概览](https://www.alibabacloud.com/help/en/oss/user-guide/access-and-network-overview)和[绑定自定义域名](https://www.alibabacloud.com/help/en/oss/user-guide/access-buckets-via-custom-domain-names)。

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

`HeadObject` 对应 `oss:GetObject`，`DeleteMultipleObjects` 对应 `oss:DeleteObject`；参见[HeadObject 权限](https://www.alibabacloud.com/help/en/oss/developer-reference/headobject)、[DeleteMultipleObjects 权限](https://www.alibabacloud.com/help/en/oss/developer-reference/deletemultipleobjects)和[签名下载权限](https://www.alibabacloud.com/help/en/oss/user-guide/how-to-obtain-the-url-of-a-single-object-or-the-urls-of-multiple-objects)。服务端身份不需要 Bucket 列举或 OSS 管理权限。

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
- 生产和开发 CORS 都是精确 origin，无通配 origin/header。
- 中国大陆受影响账号的自定义域名、ICP 和 HTTPS 证书均生效。
- 浏览器 STS 有效期为 900 秒，策略只有当前 owner/pattern 前缀和三项 action。
- 浏览器凭证不能读取对象、列举 Bucket、访问其他图案或其他用户前缀。
- 本地 RAM 调用者和 ECS 实例角色只能假设指定上传角色。
- 7 天未完成 multipart 生命周期规则已启用。
- 应用日志和数据库中没有长期密钥、security token 或签名 URL。
