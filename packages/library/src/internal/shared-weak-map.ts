// Both entry formats resolve this same internal CommonJS module in Node.
const registries = new Map<string, WeakMap<object, unknown>>();

export function sharedWeakMap<K extends object, V>(
  name: string,
): WeakMap<K, V> {
  const existing = registries.get(name);
  if (existing !== undefined) return existing as WeakMap<K, V>;
  const created = new WeakMap<K, V>();
  registries.set(name, created);
  return created;
}
