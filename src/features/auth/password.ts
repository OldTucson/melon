import argon2 from "argon2";
import { z } from "zod";

export const passwordSchema = z.string().min(12).max(128);

export const argonOptions = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const;

export const hashPassword = (password: string) =>
  argon2.hash(passwordSchema.parse(password), argonOptions);

export const verifyPassword = (password: string, hash: string) =>
  argon2.verify(hash, password);
