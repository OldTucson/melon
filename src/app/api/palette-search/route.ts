import { requireApiUser } from "@/features/auth/api-session";
import { paletteSearchRequestSchema } from "@/features/palette-search/contracts";
import { searchPatternsByPalette } from "@/features/palette-search/palette-search-service";
import { AppError } from "@/lib/http/app-error";
import { assertSameOrigin, withRoute } from "@/lib/http/route";

export const runtime = "nodejs";

const invalidColors = (status = 400) =>
  new AppError(
    "PALETTE_SEARCH_INVALID_COLORS",
    status,
    "Invalid palette colors",
  );

function requireJsonContentType(request: Request) {
  const mediaType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") throw invalidColors(415);
}

async function readPaletteSearchBody(request: Request) {
  try {
    return await request.json();
  } catch {
    throw invalidColors();
  }
}

const handlePost = withRoute(async (request: Request) => {
  const user = await requireApiUser();
  assertSameOrigin(request);
  requireJsonContentType(request);
  const parsed = paletteSearchRequestSchema.safeParse(
    await readPaletteSearchBody(request),
  );
  if (!parsed.success) throw invalidColors();

  const result = await searchPatternsByPalette({
    ownerId: user.id,
    requestId: parsed.data.requestId,
    colors: parsed.data.colors,
    filters: parsed.data.filters,
    signal: request.signal,
  });
  return Response.json(result);
});

export async function POST(request: Request) {
  const response = await handlePost(request);
  response.headers.set("cache-control", "private, no-store");
  return response;
}
