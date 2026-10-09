import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { loadSessionUser } from "@/features/auth/session";

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

  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-labelledby="login-title">
        <p className="wordmark">melon</p>
        <h1 id="login-title">登录</h1>
        <LoginForm />
      </section>
    </main>
  );
}
