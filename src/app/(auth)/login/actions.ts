"use server";

import { AuthError } from "next-auth";
import { z } from "zod";

import { signIn } from "@/auth";

import type { LoginState } from "./state";

const loginInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
});

export async function loginAction(
  _previousState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = loginInput.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: "邮箱或密码不正确。" };
  }

  try {
    await signIn("credentials", {
      ...parsed.data,
      redirectTo: "/library",
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: "邮箱或密码不正确。" };
    }
    throw error;
  }

  return { error: null };
}
