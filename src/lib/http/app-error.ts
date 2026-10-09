export type AppErrorCode =
  | "INTERNAL_ERROR"
  | "INVALID_CURSOR"
  | "NOT_FOUND"
  | "OPERATION_ID_REUSED"
  | "PATTERN_STATE_CHANGED"
  | "TAG_LIMIT_EXCEEDED"
  | "TAG_NAME_CONFLICT"
  | "VALIDATION_ERROR";

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;

  constructor(code: AppErrorCode, status: number, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}

export const validationError = () =>
  new AppError("VALIDATION_ERROR", 400, "Invalid request");
