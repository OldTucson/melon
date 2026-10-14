import "server-only";

import { isRedirectError } from "next/dist/client/components/redirect-error";

import { AppError } from "@/lib/http/app-error";

import { requireUser } from "./session";

export async function requireApiUser() {
  try {
    return await requireUser();
  } catch (error) {
    if (isRedirectError(error)) {
      throw new AppError("UNAUTHORIZED", 401, "Authentication required");
    }
    throw error;
  }
}
