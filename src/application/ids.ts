/** Time-ordered UUIDv7, so primary keys stay index-friendly. */
export const newId = (): string => Bun.randomUUIDv7();
