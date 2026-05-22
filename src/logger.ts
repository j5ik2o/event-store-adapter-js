interface Logger {
  // biome-ignore lint/suspicious/noExplicitAny: Logger accepts any content type
  trace?: (...content: any[]) => void;
  // biome-ignore lint/suspicious/noExplicitAny: Logger accepts any content type
  debug: (...content: any[]) => void;
  // biome-ignore lint/suspicious/noExplicitAny: Logger accepts any content type
  info: (...content: any[]) => void;
  // biome-ignore lint/suspicious/noExplicitAny: Logger accepts any content type
  warn: (...content: any[]) => void;
  // biome-ignore lint/suspicious/noExplicitAny: Logger accepts any content type
  error: (...content: any[]) => void;
}

export type { Logger };
