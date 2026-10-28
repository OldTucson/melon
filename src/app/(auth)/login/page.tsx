import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { loadSessionUser } from "@/features/auth/session";
import { toPublicLegalConfig } from "@/features/legal/legal-config";
import { LegalLinks } from "@/features/legal/legal-links";
import { getServerEnv } from "@/lib/env/server";

import { LoginForm } from "./login-form";

export default async function LoginPage() {
  const session = await auth();
  if (session?.user?.id && typeof session.user.sessionVersion === "number") {
    const user = await loadSessionUser({
      id: session.user.id,
      sessionVersion: session.user.sessionVersion,
    });

    if (user) {
      redirect(user.mustChangePassword ? "/change-password" : "/library");
    }
  }

  const legalConfig = toPublicLegalConfig(getServerEnv());

  return (
    <main
      aria-labelledby="login-title"
      className="auth-shell"
    >
      <section className="auth-panel" aria-labelledby="login-title">
        <header className="auth-panel-header">
          <p className="wordmark">melon</p>
          <h1 id="login-title">登录</h1>
        </header>
        <LoginForm />
      </section>
      <LegalLinks className="auth-legal" config={legalConfig} />
    </main>
  );
}
