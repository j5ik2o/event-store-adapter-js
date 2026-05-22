class ConverterError extends Error {
  constructor(converterName: string, error: Error) {
    super(`${converterName} failed: ${error.message}`);
    this.name = "ConverterError";
  }
}

function convertJson<T>(
  converterName: string,
  converter: (json: unknown) => T,
  json: unknown,
): T {
  try {
    return converter(json);
  } catch (error) {
    if (error instanceof ConverterError) {
      throw error;
    }
    const wrappedError =
      error instanceof Error ? error : new Error(String(error));
    throw new ConverterError(converterName, wrappedError);
  }
}

export { convertJson };
