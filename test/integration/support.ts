import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../src/config.js';
import { createOrmConfig } from '../../src/infrastructure/database/mikro-orm.config.js';

/** Real Postgres from docker-compose, migrated from scratch (down to zero, then up). */
export async function freshDatabase(): Promise<MikroORM> {
  const orm = await MikroORM.init(createOrmConfig(loadConfig().databaseUrl));
  await orm.migrator.down({ to: 0 });
  await orm.migrator.up();
  return orm;
}

export async function sql<T = Record<string, unknown>>(orm: MikroORM, query: string, params: unknown[] = []): Promise<T[]> {
  return (await orm.em.getConnection().execute(query, params)) as T[];
}
