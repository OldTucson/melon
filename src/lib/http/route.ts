import { randomUUID } from "node:crypto";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { ZodError } from "zod";

import { getServerEnv } from "@/lib/env/server";

import { AppError, validationError } from "./app-error";

type RouteHandler<Context = unknown> = (
  request: Request,
  context?: Context,
) => Response | Promise<Response>;

const errorResponse = (
  code: string,
  message: string,
  status: number,
  requestId: string,
  details?: unknown,
) =>
  Response.json(
    {
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
      },
    },
    { status, headers: { "x-request-id": requestId } },
  );

export const withRoute = <Context = unknown>(
  handler: RouteHandler<Context>,
): RouteHandler<Context> =>
  async (request, context) => {
    const requestId = randomUUID();

    try {
      const response = await handler(request, context);
      response.headers.set("x-request-id", requestId);
      return response;
    } catch (error) {
      if (isRedirectError(error)) throw error;
      if (error instanceof AppError) {
        return errorResponse(
          error.code,
          error.message,
          error.status,
          requestId,
          error.details,
        );
      }
      if (error instanceof ZodError) {
        return errorResponse(
          "VALIDATION_ERROR",
          "Invalid request",
          400,
          requestId,
        );
      }
      return errorResponse(
        "INTERNAL_ERROR",
        "Internal server error",
        500,
        requestId,
      );
    }
  };

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw validationError();
  }
}

export function assertSameOrigin(
  request: Request,
  expectedOrigin = getServerEnv().APP_ORIGIN,
) {
  const origin = request.headers.get("origin");
  let normalizedOrigin: string | undefined;
  try {
    normalizedOrigin = origin ? new URL(origin).origin : undefined;
  } catch {
    normalizedOrigin = undefined;
  }
  if (
    origin === "null" ||
    normalizedOrigin === undefined ||
    normalizedOrigin !== new URL(expectedOrigin).origin
  ) {
    throw new AppError(
      "FORBIDDEN_ORIGIN",
      403,
      "Request origin is not allowed",
    );
  }
}
