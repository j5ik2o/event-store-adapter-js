function convertJson<T>(
  converterName: string,
  converter: (json: unknown) => T,
  json: unknown,
): T {
  try {
    return converter(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith(`${converterName} failed:`)) {
      throw error;
    }
    throw new Error(`${converterName} failed: ${message}`);
  }
}

export { convertJson };
