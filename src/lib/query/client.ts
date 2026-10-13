import { QueryClient } from "@tanstack/react-query";

export class ApiResponseError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    status: number,
    code: string,
    message = "Request failed",
    details?: unknown,
  ) {
    super(message);
    this.name = "ApiResponseError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function readApiResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as
    | (T & { error?: { code?: string; message?: string; details?: unknown } })
    | null;
  if (!response.ok) {
    throw new ApiResponseError(
      response.status,
      body?.error?.code ?? "REQUEST_FAILED",
      body?.error?.message ?? "Request failed",
      body?.error?.details,
    );
  }
  return body as T;
}

const retryRead = (failureCount: number, error: Error) => {
  if (
    error instanceof ApiResponseError &&
    error.status >= 400 &&
    error.status < 500
  ) {
    return false;
  }
  return failureCount < 2;
};

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: retryRead,
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: 0 },
    },
  });
}

let browserQueryClient:
  | { ownerId: string; queryClient: QueryClient }
  | undefined;

export function getQueryClient(ownerId: string) {
  if (typeof window === "undefined") return createQueryClient();
  if (!browserQueryClient || browserQueryClient.ownerId !== ownerId) {
    browserQueryClient = { ownerId, queryClient: createQueryClient() };
  }
  return browserQueryClient.queryClient;
}
