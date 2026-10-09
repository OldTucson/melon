import { requireUser } from "@/features/auth/session";
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
    </main>
  );
}
