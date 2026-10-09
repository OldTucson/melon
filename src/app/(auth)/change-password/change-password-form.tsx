"use client";

import { useActionState, useEffect, useRef } from "react";

import { changePasswordAction } from "./actions";
import { initialChangePasswordState } from "./state";

export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState(
    changePasswordAction,
    initialChangePasswordState,
  );
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (state.error) errorRef.current?.focus();
  }, [state]);

  return (
    <form action={formAction} className="form-stack" aria-label="更新密码">
      <label className="form-field">
        <span>当前密码</span>
        <input
          type="password"
          name="currentPassword"
          autoComplete="current-password"
          required
          autoFocus
          maxLength={128}
        />
      </label>
      <label className="form-field">
        <span>新密码</span>
        <input
          type="password"
          name="newPassword"
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={128}
        />
      </label>
      <label className="form-field">
        <span>确认新密码</span>
        <input
          type="password"
          name="confirmPassword"
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={128}
        />
      </label>
      {state.error ? (
        <p className="form-error" role="alert" tabIndex={-1} ref={errorRef}>
          {state.error}
        </p>
      ) : null}
      <button className="primary-button" type="submit" disabled={pending}>
        {pending ? "更新中" : "更新密码"}
      </button>
    </form>
  );
}
