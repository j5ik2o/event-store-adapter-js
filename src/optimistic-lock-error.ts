class OptimisticLockError extends Error {
  constructor(message: string, cause?: Error) {
    super(message, { cause });
    this.name = "OptimisticLockError";
  }
}

export { OptimisticLockError };
