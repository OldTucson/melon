import { requireUser } from "@/features/auth/session";
import { AuthorizationFieldSettings } from "@/features/authorizations/field-settings";
import { ImageSearchIndexSettings } from "@/features/image-search/index-settings";
import { toPublicLegalConfig } from "@/features/legal/legal-config";
import { LegalLinks } from "@/features/legal/legal-links";
import { ThemeControl } from "@/features/theme/theme-control";
import { getServerEnv } from "@/lib/env/server";

export default async function SettingsPage() {
  await requireUser();
  const legalConfig = toPublicLegalConfig(getServerEnv());

  return (
    <main className="settings-page">
      <header className="settings-header">
        <h1>设置</h1>
      </header>
      <section className="settings-section" aria-labelledby="appearance-title">
        <h2 id="appearance-title">外观</h2>
        <ThemeControl />
      </section>
      <section
        className="settings-section"
        aria-labelledby="authorization-fields-title"
      >
        <div className="settings-section-label">
          <h2 id="authorization-fields-title">授权领域</h2>
          <p>维护商业授权使用的领域字典。</p>
        </div>
        <AuthorizationFieldSettings />
      </section>
      <section
        className="settings-section"
        aria-labelledby="image-search-index-title"
      >
        <div className="settings-section-label">
          <h2 id="image-search-index-title">图像搜索索引</h2>
          <p>查看当前索引覆盖和后台处理状态。</p>
        </div>
        <ImageSearchIndexSettings />
      </section>
      <section
        className="settings-section"
        aria-labelledby="legal-settings-title"
      >
        <div className="settings-section-label">
          <h2 id="legal-settings-title">法律与备案</h2>
          <p>查看服务政策、运营者联系方式与已配置的备案信息。</p>
        </div>
        <LegalLinks className="settings-legal-links" config={legalConfig} />
      </section>
    </main>
  );
}
