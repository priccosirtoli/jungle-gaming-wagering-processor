import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../config.js';
import { createOrmConfig } from './mikro-orm.config.js';

const direction = process.argv[2] ?? 'up';
if (direction !== 'up' && direction !== 'down') {
  console.error(`Unknown direction "${direction}", use "up" or "down"`);
  process.exit(1);
}

const orm = await MikroORM.init(createOrmConfig(loadConfig().databaseUrl));
try {
  const migrator = orm.migrator;
  const executed = direction === 'up' ? await migrator.up() : await migrator.down();
  console.log(JSON.stringify({ direction, migrations: executed.map((m) => m.name) }));
} finally {
  await orm.close(true);
}
