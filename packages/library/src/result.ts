export type Result<T, E> =
  | {
      type: "ok";
      value: T;
    }
  | {
      type: "err";
      error: E;
    };

export namespace Result {
  export function ok<T>(value: T): Result<T, never> {
    return Object.freeze({
      type: "ok",
      value,
    });
  }

  export function err<E>(error: E): Result<never, E> {
    return Object.freeze({
      type: "err",
      error,
    });
  }
}

Object.freeze(Result);
