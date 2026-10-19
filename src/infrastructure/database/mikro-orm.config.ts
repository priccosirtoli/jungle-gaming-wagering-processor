import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { migrationsList } from './migrations/index.js';

/**
 * Migrations are hand-written SQL registered explicitly (no file discovery),
 * so the schema (constraints, checks, triggers) is reviewed as code and every
 * migration ships its `down()`.
 */
export function createOrmConfig(databaseUrl: string) {
  return defineConfig({
    clientUrl: databaseUrl,
    entities: [],
    extensions: [Migrator],
    discovery: { warnWhenNoEntities: false },
    migrations: {
      tableName: 'schema_migrations',
      migrationsList,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      snapshotOnMigrate: false,
    },
    pool: { min: 2, max: 10 },
    debug: false,
  });
}
