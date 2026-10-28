import { z } from "zod";
import { readApiResponse } from "@/lib/query/client";
import {
  inspirationCreateMutationSchema,
  inspirationDetailDtoSchema,
  inspirationListDtoSchema,
  inspirationPatchMutationSchema,
  type InspirationCreateMutationInput,
  type InspirationPatchMutationInput,
} from "./contracts";

const root = "/api/inspiration-analyses";
const path = (id: string) =>
  `${root}/${encodeURIComponent(z.string().uuid().parse(id))}`;
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
async function detail(url: string, init?: RequestInit) {
  return inspirationDetailDtoSchema.parse(
    await readApiResponse(await fetch(url, init)),
  );
}

export const inspirationApi = {
  async list(cursor?: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ limit: "20" });
    if (cursor) query.set("cursor", cursor);
    return inspirationListDtoSchema.parse(
      await readApiResponse(await fetch(`${root}?${query}`, { signal })),
    );
  },
  detail: (id: string, signal?: AbortSignal) => detail(path(id), { signal }),
  create: (input: InspirationCreateMutationInput) =>
    detail(root, json("POST", inspirationCreateMutationSchema.parse(input))),
  rename: (id: string, input: InspirationPatchMutationInput) =>
    detail(
      path(id),
      json("PATCH", inspirationPatchMutationSchema.parse(input)),
    ),
  retry: (id: string) => detail(`${path(id)}/retry`, { method: "POST" }),
  share: (id: string, enabled: boolean) =>
    detail(`${path(id)}/share`, { method: enabled ? "POST" : "DELETE" }),
  async delete(id: string) {
    return z
      .object({ id: z.string().uuid(), deleted: z.literal(true) })
      .strict()
      .parse(
        await readApiResponse(await fetch(path(id), { method: "DELETE" })),
      );
  },
};
