import type { MigrationObject } from '@mikro-orm/core';
import { Migration0001InitialSchema } from './0001-initial-schema.js';

/** Ordered list of migrations. New migrations are appended, never reordered. */
export const migrationsList: MigrationObject[] = [
  { name: '0001-initial-schema', class: Migration0001InitialSchema },
];
