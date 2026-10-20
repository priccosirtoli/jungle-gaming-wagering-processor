import type { MigrationObject } from '@mikro-orm/core';
import { Migration0001InitialSchema } from './0001-initial-schema.js';
import { Migration0002PendingReferenceRetries } from './0002-pending-reference-retries.js';

/** Ordered list of migrations. New migrations are appended, never reordered. */
export const migrationsList: MigrationObject[] = [
  { name: '0001-initial-schema', class: Migration0001InitialSchema },
  { name: '0002-pending-reference-retries', class: Migration0002PendingReferenceRetries },
];
