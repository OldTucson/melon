export type UploadAttemptToken = symbol;

export class UploadAttemptRegistry {
  private readonly current = new Map<string, UploadAttemptToken>();
  private readonly running = new Map<string, Promise<unknown>>();

  begin(taskId: string) {
    const token = Symbol(taskId);
    this.current.set(taskId, token);
    return token;
  }

  isCurrent(taskId: string, token: UploadAttemptToken) {
    return this.current.get(taskId) === token;
  }

  runIfCurrent(
    taskId: string,
    token: UploadAttemptToken,
    callback: () => void,
  ) {
    if (this.isCurrent(taskId, token)) callback();
  }

  finish(taskId: string, token: UploadAttemptToken) {
    if (this.isCurrent(taskId, token)) this.current.delete(taskId);
  }

  invalidate(taskId: string) {
    this.current.delete(taskId);
  }

  track<T>(taskId: string, promise: Promise<T>) {
    this.running.set(taskId, promise);
    const clear = () => {
      if (this.running.get(taskId) === promise) this.running.delete(taskId);
    };
    void promise.then(clear, clear);
    return promise;
  }

  runningTask(taskId: string) {
    return this.running.get(taskId);
  }
}
