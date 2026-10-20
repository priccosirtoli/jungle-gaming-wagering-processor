# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) vindas de múltiplos provedores, por HTTP ou SQS. Ele continua correto com mensagens duplicadas, fora de ordem e processadas por várias instâncias ao mesmo tempo.

- Enunciado: [docs/CHALLENGE.md](docs/CHALLENGE.md)
- Decisões, trade-offs e limitações: [ARCHITECTURE.md](ARCHITECTURE.md)

**Stack:** Bun 1.4, TypeScript estrito, NestJS 12, PostgreSQL 17, MikroORM 7, AWS SQS via LocalStack e Docker Compose.

## Como rodar

Pré-requisitos: Bun 1.x e Docker.

```bash
bun install
docker compose up -d --wait postgres localstack   # Postgres + filas SQS (FIFO, DLQ, eventos)
bun run migrate
bun run start                                      # http://localhost:3000
```

Para rodar tudo em containers, inclusive com 3 réplicas da aplicação (portas 3000 a 3002):

```bash
docker compose --profile app up --build --scale app=3
```

Cada instância roda a API, o consumer SQS, o publisher da outbox e o worker de referências pendentes. Não há configuração especial para escalar.

## Testes

Os testes de integração e de concorrência usam PostgreSQL e LocalStack reais, então suba o Compose antes.

| Comando | O que roda |
|---|---|
| `bun run test:unit` | domínio, sem infraestrutura |
| `bun run test:integration` | schema e constraints, API, SQS (inbox, retry, DLQ), outbox, atomicidade, referências pendentes |
| `bun run test:concurrency` | 3 processos separados do serviço, mais `SIGKILL` e reinício no meio da carga |
| `bun run typecheck` | TypeScript estrito |
| `bun run migrate` / `bun run migrate:down` | aplica ou reverte a última migration |

O CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) roda tudo isso a cada push: typecheck, unidade, migrations (up, down, down, up), integração, concorrência e build da imagem.

## API

```bash
# Criar wallet (o saldo inicial vira um crédito OPENING no ledger)
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# Submeter uma aposta (Idempotency-Key é obrigatório)
curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<id>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

| Método e rota | Descrição |
|---|---|
| `POST /wallets` | cria a wallet (`409` se já existe para o player e a moeda) |
| `GET /wallets/:walletId` | saldo e `version` |
| `GET /wallets/:walletId/ledger?cursor=&limit=50` | ledger paginado por cursor opaco |
| `POST /wallets/:walletId/reconciliation` | compara o saldo com o ledger; não corrige nada |
| `POST /wagering/transactions` | submete uma transação |
| `GET /wagering/transactions/:transactionId` | consulta pelo id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | consulta pelo id do provedor |
| `GET /health/live`, `GET /health/ready` | liveness e readiness (Postgres e SQS) |
| `GET /metrics` | métricas no formato Prometheus |

Códigos de resposta: `200` processada, `202` aguardando referência, `422` rejeitada (com `failureCode`), `400` payload inválido, `409` conflito de idempotência, `503` falha transitória (pode reenviar com a mesma chave). A tabela completa está em [ARCHITECTURE.md](ARCHITECTURE.md#10-http).

### Via SQS

Envie para `wager-transactions.fifo`, com `MessageGroupId = walletId`:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": { "providerId": "provider-a", "externalTransactionId": "transaction-123", "idempotencyKey": "provider-a:transaction-123", "...": "mesmos campos do HTTP" }
}
```

Os eventos de integração são publicados na fila `wagering-events`.

## Configuração

Todas as variáveis têm default para o ambiente local (veja [.env.example](.env.example) e [src/config.ts](src/config.ts)).

| Variável | Default | Uso |
|---|---|---|
| `DATABASE_URL` | `postgresql://wagering:wagering@localhost:5432/wagering` | Postgres |
| `SQS_ENDPOINT` | — | `http://localhost:4566` com LocalStack |
| `SQS_QUEUE_NAME` / `SQS_DLQ_NAME` / `SQS_EVENTS_QUEUE_NAME` | `wager-transactions.fifo` / `wager-transactions-dlq.fifo` / `wagering-events` | filas |
| `CONSUMER_ENABLED`, `OUTBOX_ENABLED`, `PENDING_REFERENCE_ENABLED` | `true` | liga ou desliga cada worker |
| `CONSUMER_RETRY_BASE_SECONDS` / `CONSUMER_RETRY_MAX_SECONDS` | `2` / `300` | backoff dos retries do consumer |
| `PENDING_REFERENCE_MAX_ATTEMPTS` | `10` | tentativas antes de `REFERENCE_NOT_FOUND` |

## Estrutura

```
src/
  domain/          Money, Wallet, WagerTransaction, WalletLedgerEntry, eventos, OutboxMessage (sem Nest/ORM)
  application/     use cases, validação, hash canônico, worker de referências pendentes
  infrastructure/  MikroORM (schemas, mappers, migrations), SQS (consumer, publisher), logs e métricas
  http/            controllers, mapa de erros, AuthGuard no-op
test/
  unit/  integration/  concurrency/
```
