import { z } from "zod";

export const normalizedUuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
