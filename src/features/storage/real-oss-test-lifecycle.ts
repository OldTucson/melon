export interface RealOssTestLifecycleOptions<T> {
  body(signal: AbortSignal): Promise<T>;
  bodyTimeoutMs: number;
  cancelBody(): void;
  cleanup(): Promise<void>;
  cleanupTimeoutMs: number;
}

export interface FetchBytesOptions {
  fetchImplementation?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs: number;
}

type DeadlineCode =
  | "REAL_OSS_BODY_TIMEOUT"
  | "REAL_OSS_CLEANUP_TIMEOUT"
  | "REAL_OSS_FETCH_TIMEOUT";

class RealOssTestDeadlineError extends Error {
  readonly code: DeadlineCode;

  constructor(code: DeadlineCode) {
    super(code);
    this.name = "RealOssTestDeadlineError";
    this.code = code;
  }
}

function requireTimeout(timeoutMs: number) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("REAL_OSS_TIMEOUT_INVALID");
  }
  return timeoutMs;
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  code: DeadlineCode,
  onTimeout?: (error: RealOssTestDeadlineError) => void,
) {
  const duration = requireTimeout(timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const deadlineError = new RealOssTestDeadlineError(code);
      try {
        onTimeout?.(deadlineError);
        reject(deadlineError);
      } catch (cancellationError) {
        reject(
          new AggregateError(
            [deadlineError, cancellationError],
            "REAL_OSS_TIMEOUT_CANCELLATION_FAILED",
          ),
        );
      }
    }, duration);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runRealOssTestLifecycle<T>(
  options: RealOssTestLifecycleOptions<T>,
): Promise<T> {
  const bodyController = new AbortController();
  const bodyPromise = Promise.resolve().then(() =>
    options.body(bodyController.signal),
  );
  let bodyOutcome:
    | { ok: true; value: T }
    | { error: unknown; ok: false };

  try {
    bodyOutcome = {
      ok: true,
      value: await withDeadline(
        bodyPromise,
        options.bodyTimeoutMs,
        "REAL_OSS_BODY_TIMEOUT",
        (deadlineError) => {
          bodyController.abort(deadlineError);
          options.cancelBody();
        },
      ),
    };
  } catch (error) {
    bodyOutcome = { error, ok: false };
  }

  let cleanupOutcome:
    | { ok: true }
    | { error: unknown; ok: false };
  try {
    await withDeadline(
      Promise.resolve().then(options.cleanup),
      options.cleanupTimeoutMs,
      "REAL_OSS_CLEANUP_TIMEOUT",
    );
    cleanupOutcome = { ok: true };
  } catch (error) {
    cleanupOutcome = { error, ok: false };
  }

  if (!bodyOutcome.ok && !cleanupOutcome.ok) {
    throw new AggregateError(
      [bodyOutcome.error, cleanupOutcome.error],
      "REAL_OSS_BODY_AND_CLEANUP_FAILED",
    );
  }
  if (!cleanupOutcome.ok) throw cleanupOutcome.error;
  if (!bodyOutcome.ok) throw bodyOutcome.error;
  return bodyOutcome.value;
}

export async function fetchBytesWithTimeout(
  url: string,
  options: FetchBytesOptions,
): Promise<{ bytes: ArrayBuffer; response: Response }> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) {
    abortFromParent();
  } else {
    options.signal?.addEventListener("abort", abortFromParent, { once: true });
  }
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const request = Promise.resolve().then(async () => {
    const response = await fetchImplementation(url, {
      signal: controller.signal,
    });
    const bytes = await response.arrayBuffer();
    return { bytes, response };
  });

  try {
    return await withDeadline(
      request,
      options.timeoutMs,
      "REAL_OSS_FETCH_TIMEOUT",
      (deadlineError) => controller.abort(deadlineError),
    );
  } finally {
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}
