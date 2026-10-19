import type { MigrationObject } from '@mikro-orm/core';

/** Ordered list of migrations. New migrations are appended, never reordered. */
export const migrationsList: MigrationObject[] = [];
