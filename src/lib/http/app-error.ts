export type AppErrorCode =
  | "BATCH_LIMIT_EXCEEDED"
  | "FORBIDDEN_ORIGIN"
  | "FOLDER_BATCH_ACTION_REQUIRED"
  | "FOLDER_DELETE_SCOPE_CHANGED"
  | "FOLDER_NAME_CONFLICT"
  | "FOLDER_NOT_ACTIVE"
  | "FOLDER_NOT_FOUND"
  | "FOLDER_STATE_CHANGED"
  | "INTERNAL_ERROR"
  | "INVALID_CURSOR"
  | "NOT_FOUND"
  | "OPERATION_ID_REUSED"
  | "OSS_DELETE_FAILED"
  | "PATTERN_STATE_CHANGED"
  | "TAG_LIMIT_EXCEEDED"
  | "TAG_NAME_CONFLICT"
  | "TRASH_BATCH_NOT_FOUND"
  | "TRASH_PURGE_DEFERRED"
  | "TRASH_PURGE_IN_PROGRESS"
  | "UPLOAD_CANNOT_CANCEL_COMPLETED"
  | "UPLOAD_CREDENTIALS_UNAVAILABLE"
  | "UPLOAD_EXTENSION_UNSUPPORTED"
  | "UPLOAD_FILE_TOO_LARGE"
  | "UPLOAD_ID_CONFLICT"
  | "UPLOAD_OBJECT_INVALID"
  | "UPLOAD_SESSION_EXPIRED"
  | "UPLOAD_SESSION_INVALID_STATE"
  | "UPLOAD_SIGNATURE_MISMATCH"
  | "UPLOAD_STORAGE_UNAVAILABLE"
  | "VALIDATION_ERROR";

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(
    code: AppErrorCode,
    status: number,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const validationError = () =>
  new AppError("VALIDATION_ERROR", 400, "Invalid request");
