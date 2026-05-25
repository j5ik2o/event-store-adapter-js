const converterErrorBrand = Symbol("converterError");

function createConverterError(converterName: string, error: Error): Error {
  const converterError = new Error(`${converterName} failed: ${error.message}`);
  converterError.name = "ConverterError";
  converterError.cause = error;
  (
    converterError as Error & {
      [converterErrorBrand]: true;
    }
  )[converterErrorBrand] = true;
  return converterError;
}

function convertJson<T>(
  converterName: string,
  converter: (json: unknown) => T,
  json: unknown,
): T {
  try {
    return converter(json);
  } catch (error) {
    if (
      error instanceof Error &&
      (error as Error & { [converterErrorBrand]?: true })[
        converterErrorBrand
      ] === true
    ) {
      throw error;
    }
    const wrappedError =
      error instanceof Error ? error : new Error(String(error));
    throw createConverterError(converterName, wrappedError);
  }
}

export { convertJson };
