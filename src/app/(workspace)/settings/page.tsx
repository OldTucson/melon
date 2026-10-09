import { requireUser } from "@/features/auth/session";
import { ThemeControl } from "@/features/theme/theme-control";

export default async function SettingsPage() {
  const user = await requireUser();

  return (
    <main className="settings-page">
      <header className="settings-header">
        <p className="wordmark">melon</p>
        <h1>设置</h1>
      </header>
      <section className="settings-section" aria-labelledby="appearance-title">
        <h2 id="appearance-title">外观</h2>
        <ThemeControl serverPreference={user.themePreference} />
      </section>
    </main>
  );
}
