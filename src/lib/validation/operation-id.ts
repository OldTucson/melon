import { z } from "zod";

export const publicOperationIdSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
  .refine((value) => value[14] === "4", {
    message: "Public operation ID must be a UUID v4",
  });
