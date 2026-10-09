"use server";

import { z } from "zod";

import { signOut } from "@/auth";
import { passwordSchema } from "@/features/auth/password";
import { requireUser } from "@/features/auth/session";
import { changeUserPassword } from "@/features/auth/user-admin";

const changePasswordInput = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((input) => input.newPassword === input.confirmPassword);

export type ChangePasswordState = { error: string | null };

export const initialChangePasswordState: ChangePasswordState = { error: null };

export async function changePasswordAction(
  _previousState: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const parsed = changePasswordInput.safeParse({
    currentPassword: formData.get("currentPassword"),
    newPassword: formData.get("newPassword"),
    confirmPassword: formData.get("confirmPassword"),
  });

  if (!parsed.success) {
    return { error: "无法更改密码，请检查输入后重试。" };
  }

  const user = await requireUser();

  try {
    await changeUserPassword({
      userId: user.id,
      currentPassword: parsed.data.currentPassword,
      newPassword: parsed.data.newPassword,
    });
  } catch {
    return { error: "无法更改密码，请重试。" };
  }

  await signOut({ redirectTo: "/login" });
  return initialChangePasswordState;
}
