import { requireUser } from "@/features/auth/session";

import { ChangePasswordForm } from "./change-password-form";

export default async function ChangePasswordPage() {
  await requireUser();

  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-labelledby="password-title">
        <p className="wordmark">melon</p>
        <h1 id="password-title">更新密码</h1>
        <ChangePasswordForm />
      </section>
    </main>
  );
}
