# Distributed Wagering Processor

Jungle Gaming backend challenge. The full challenge statement is in [docs/CHALLENGE.md](docs/CHALLENGE.md).

Stack: Bun 1.4, TypeScript (strict), NestJS 12, PostgreSQL 17, MikroORM 7, AWS SQS via LocalStack, Docker Compose.

## Running locally

```bash
bun install
docker compose up -d --wait postgres localstack
bun run migrate
bun run start
```

Or run the app in a container too:

```bash
docker compose --profile app up --build
```

Health checks: `GET /health/live` and `GET /health/ready`.

## Commands

| Command | What it does |
|---|---|
| `bun run start` | Starts the API |
| `bun run migrate` / `bun run migrate:down` | Applies / reverts migrations |
| `bun run typecheck` | TypeScript strict check |
| `bun run test:unit` | Unit tests (no infrastructure) |
| `bun run test:integration` | Integration tests against real Postgres and LocalStack |

CI (`.github/workflows/ci.yml`) runs all of the above on every push, with Postgres and LocalStack started by Docker Compose.
