import type { Metadata } from "next";

import { toPublicLegalConfig } from "@/features/legal/legal-config";
import { LegalPage } from "@/features/legal/legal-page";
import { getServerEnv } from "@/lib/env/server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "隐私政策 | melon",
  description: "melon 私有图案资料库的隐私政策",
};

export default async function PrivacyPage() {
  const config = toPublicLegalConfig(getServerEnv());

  return (
    <LegalPage
      config={config}
      effectiveDate={config.effectiveDate}
      title="隐私政策"
    >
      <section className="legal-section">
        <h2>信息处理者</h2>
        <p>
          {config.operatorName
            ? `${config.operatorName} 负责运营本私有邀请制图案资料库并处理本政策所述信息。`
            : "本服务是仅向受邀成员开放的私有图案资料库，由邀请您使用服务的管理员负责运营。"}
        </p>
      </section>

      <section className="legal-section">
        <h2>处理的信息</h2>
        <ul>
          <li>账户邮箱、显示名称、角色、账户状态与安全设置。</li>
          <li>上传的图案与预览文件、标签、文件夹及相关技术元数据。</li>
          <li>授权记录、客户与项目字段、授权范围及业务记录。</li>
          <li>登录失败、安全日志、操作记录和必要的故障诊断信息。</li>
        </ul>
        <p>
          以图搜图的查询图片仅用于处理当前一次搜索请求，不会作为素材加入图库，也不会保存为搜索历史。
        </p>
      </section>

      <section className="legal-section">
        <h2>处理目的</h2>
        <p>
          我们仅为提供账户访问、素材存储与预览、标签和文件夹管理、授权管理、搜索、下载、删除恢复及安全审计而处理上述信息。
        </p>
      </section>

      <section className="legal-section">
        <h2>存储与安全</h2>
        <p>
          结构化数据保存在受控数据库中，文件保存在对象存储（OSS）中，应用运行于受限的服务器基础设施。我们采用访问控制、传输加密、最小权限、登录限流、备份及安全日志等措施降低未授权访问风险。
        </p>
      </section>

      <section className="legal-section">
        <h2>保存期限</h2>
        <p>
          账户与业务资料在提供服务所需期间保存。进入回收站的资料通常保留 30 天，期满后由清理任务永久删除；为履行安全、审计或争议处理义务确需继续保存的除外。
        </p>
      </section>

      <section className="legal-section">
        <h2>用户权利</h2>
        <p>
          您可以联系管理员申请访问、更正、导出或删除与您有关的信息，也可以提出限制处理、撤回使用请求或注销受邀账户。我们会在核实身份后处理合理请求。
        </p>
      </section>

      <section className="legal-section">
        <h2>政策更新</h2>
        <p>
          服务范围或信息处理方式发生实质变化时，我们会更新本政策的生效日期，并通过适当方式通知受邀成员。
        </p>
      </section>

      <section className="legal-section">
        <h2>联系我们</h2>
        <p>
          {config.contactEmail
            ? `如需行使权利或咨询本政策，请发送邮件至 ${config.contactEmail}，并说明您的账户与请求事项。`
            : "如需行使权利或咨询本政策，请联系邀请您使用本服务的管理员，并说明您的账户与请求事项。"}
        </p>
      </section>
    </LegalPage>
  );
}
