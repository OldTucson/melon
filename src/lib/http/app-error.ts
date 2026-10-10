export type AppErrorCode =
  | "FORBIDDEN_ORIGIN"
  | "INTERNAL_ERROR"
  | "INVALID_CURSOR"
  | "NOT_FOUND"
  | "OPERATION_ID_REUSED"
  | "PATTERN_STATE_CHANGED"
  | "TAG_LIMIT_EXCEEDED"
  | "TAG_NAME_CONFLICT"
  | "UPLOAD_CANNOT_CANCEL_COMPLETED"
  | "UPLOAD_CREDENTIALS_UNAVAILABLE"
  | "UPLOAD_EXTENSION_UNSUPPORTED"
  | "UPLOAD_FILE_TOO_LARGE"
  | "UPLOAD_OBJECT_INVALID"
  | "UPLOAD_SESSION_EXPIRED"
  | "UPLOAD_SESSION_INVALID_STATE"
  | "UPLOAD_SIGNATURE_MISMATCH"
  | "UPLOAD_STORAGE_UNAVAILABLE"
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
