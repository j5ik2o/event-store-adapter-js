class OptimisticLockError extends Error {
  constructor(message: string, cause?: Error) {
    super(message);
    this.name = "OptimisticLockError";
    this.cause = cause;
    if (cause) {
      this.stack = `${this.stack}\nCaused by:\n${cause.stack}`;
    }
  }
}

export { OptimisticLockError };
