"use server";

import { AuthError } from "next-auth";
import { z } from "zod";

import { signIn } from "@/auth";

const loginInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
});

export type LoginState = { error: string | null };

export const initialLoginState: LoginState = { error: null };

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

  return initialLoginState;
}
