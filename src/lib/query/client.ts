import { QueryClient } from "@tanstack/react-query";

export class ApiResponseError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message = "Request failed") {
    super(message);
    this.name = "ApiResponseError";
    this.status = status;
    this.code = code;
  }
}

export async function readApiResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as
    | (T & { error?: { code?: string; message?: string } })
    | null;
  if (!response.ok) {
    throw new ApiResponseError(
      response.status,
      body?.error?.code ?? "REQUEST_FAILED",
      body?.error?.message ?? "Request failed",
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

let browserQueryClient: QueryClient | undefined;

export function getQueryClient() {
  if (typeof window === "undefined") return createQueryClient();
  browserQueryClient ??= createQueryClient();
  return browserQueryClient;
}
