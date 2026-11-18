export function sharedWeakMap<K extends object, V>(
  name: string,
): WeakMap<K, V> {
  const key = Symbol.for(name);
  const existing: unknown = Reflect.get(globalThis, key);
  if (existing instanceof WeakMap) return existing as WeakMap<K, V>;
  const created = new WeakMap<K, V>();
  Reflect.set(globalThis, key, created);
  return created;
}
