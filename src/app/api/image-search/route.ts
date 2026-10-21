import { requireApiUser } from "@/features/auth/api-session";
import { parseBoundedImageSearchMultipart } from "@/features/image-search/bounded-multipart";
import { imageSearchRequestFieldsSchema } from "@/features/image-search/contracts";
import { searchPatternsByImage } from "@/features/image-search/search-service";
import { validationError } from "@/lib/http/app-error";
import { assertSameOrigin, withRoute } from "@/lib/http/route";

export const runtime = "nodejs";

export const POST = withRoute(async (request: Request) => {
  const user = await requireApiUser();
  assertSameOrigin(request);
  const multipart = await parseBoundedImageSearchMultipart(request);
  let rawFilters: unknown;
  try {
    rawFilters = JSON.parse(multipart.filters);
  } catch {
    throw validationError();
  }
  const fields = imageSearchRequestFieldsSchema.parse({
    filters: rawFilters,
    requestId: multipart.requestId,
  });
  const result = await searchPatternsByImage({
    ownerId: user.id,
    image: multipart.image,
    filters: fields.filters,
    requestId: fields.requestId,
    signal: request.signal,
  });
  return Response.json(result, {
    headers: { "cache-control": "private, no-store" },
  });
});
