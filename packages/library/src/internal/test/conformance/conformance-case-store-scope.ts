import type { ConformanceCreatedStore } from "./conformance-created-store";
import type { ConformanceStoreBinding } from "./conformance-store-binding";
import type { ConformanceStoreCreation } from "./conformance-store-creation";

export async function withCaseStore<E, S, T>(
  binding: ConformanceStoreBinding<E, S>,
  creation: ConformanceStoreCreation,
  body: (created: ConformanceCreatedStore<E, S>) => Promise<T>,
): Promise<T> {
  const created = await binding.createStore(creation);
  try {
    return await body(created);
  } finally {
    await created.dispose();
  }
}
