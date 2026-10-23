import type { Metadata } from "next";

import { toPublicLegalConfig } from "@/features/legal/legal-config";
import { LegalPage } from "@/features/legal/legal-page";
import { getServerEnv } from "@/lib/env/server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "服务协议 | melon",
  description: "melon 私有图案资料库的服务协议",
};

export default async function TermsPage() {
  const config = toPublicLegalConfig(getServerEnv());

  return (
    <LegalPage
      config={config}
      effectiveDate={config.effectiveDate}
      title="服务协议"
    >
      <section className="legal-section">
        <h2>私有邀请</h2>
        <p>
          本服务仅向受邀成员开放，不设自助公开注册。账户由管理员按实际协作需要创建，邀请对象不得出售、转让或共享账户访问资格。
        </p>
      </section>

      <section className="legal-section">
        <h2>账户保护</h2>
        <p>
          您应使用可靠密码并妥善保管登录信息，发现异常访问后应立即联系管理员。通过您账户完成的操作将用于审计和故障处理。
        </p>
      </section>

      <section className="legal-section">
        <h2>内容权利与必要授权</h2>
        <p>
          用户保留其上传内容的所有权，并确认有权处理和上传相关素材。为运行本服务，用户仅授予运营者在服务期间实施预览、存储、搜索、下载与删除所必需的非独占处理权限；该权限不用于独立销售或另作公开传播。
        </p>
      </section>

      <section className="legal-section">
        <h2>禁止内容与行为</h2>
        <p>
          不得上传违法、侵权、恶意代码或违反授权范围的内容，不得绕过访问控制、探测他人账户、干扰系统运行，或利用本服务侵害第三方合法权益。
        </p>
      </section>

      <section className="legal-section">
        <h2>服务可用性</h2>
        <p>
          我们会合理维护服务、备份与安全措施，但维护、网络、云基础设施或不可抗力可能造成短时中断。计划维护或重大故障会在可行范围内通知受邀成员。
        </p>
      </section>

      <section className="legal-section">
        <h2>删除与保存</h2>
        <p>
          用户可按产品提供的功能删除资料。进入回收站的资料通常保留 30 天后永久删除；已进入备份的数据会随备份轮换周期清除，法律义务或争议处理另有要求的除外。
        </p>
      </section>

      <section className="legal-section">
        <h2>暂停与终止</h2>
        <p>
          对存在安全风险、违反本协议或不再具备协作需要的账户，管理员可以暂停或终止访问。可行时，我们会提前说明原因并协助处理必要的数据请求。
        </p>
      </section>

      <section className="legal-section">
        <h2>协议变更</h2>
        <p>
          服务范围、技术能力或适用要求发生变化时，我们可能更新本协议，并更新生效日期。重大变化会通过适当方式通知受邀成员。
        </p>
      </section>

      <section className="legal-section">
        <h2>联系我们</h2>
        <p>
          {config.contactEmail
            ? `如对本协议或账户状态有疑问，请发送邮件至 ${config.contactEmail}。`
            : "如对本协议或账户状态有疑问，请联系邀请您使用本服务的管理员。"}
        </p>
      </section>
    </LegalPage>
  );
}
