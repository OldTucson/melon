import { requireUser } from "@/features/auth/session";
import { AuthorizationFieldSettings } from "@/features/authorizations/field-settings";
import { ThemeControl } from "@/features/theme/theme-control";

export default async function SettingsPage() {
  await requireUser();

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
    </main>
  );
}
