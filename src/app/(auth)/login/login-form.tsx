"use client";

import { useActionState, useEffect, useRef } from "react";

import { initialLoginState, loginAction } from "./actions";

export function LoginForm() {
  const [state, formAction, pending] = useActionState(
    loginAction,
    initialLoginState,
  );
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (state.error) errorRef.current?.focus();
  }, [state.error]);

  return (
    <form action={formAction} className="form-stack" aria-label="登录">
      <label className="form-field">
        <span>邮箱</span>
        <input
          type="email"
          name="email"
          autoComplete="email"
          required
          autoFocus
        />
      </label>
      <label className="form-field">
        <span>密码</span>
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          required
          maxLength={128}
        />
      </label>
      {state.error ? (
        <p className="form-error" role="alert" tabIndex={-1} ref={errorRef}>
          {state.error}
        </p>
      ) : null}
      <button className="primary-button" type="submit" disabled={pending}>
        {pending ? "登录中" : "登录"}
      </button>
    </form>
  );
}
