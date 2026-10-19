import { Migration } from '@mikro-orm/migrations';

/**
 * Initial schema. The financial invariants live here, not only in code:
 * - one wallet per (player_id, currency) and a non-negative balance;
 * - one transaction per idempotency key and per (provider_id, external_transaction_id);
 * - a reference is reverted at most once per reversal kind;
 * - ledger entries are balanced, at most one per transaction, and append-only;
 * - terminal transactions cannot change.
 */
export class Migration0001InitialSchema extends Migration {
  override up(): void {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance numeric(20, 2) not null check (balance >= 0),
        version integer not null check (version >= 1),
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_player_currency_unique unique (player_id, currency)
      );
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash char(64) not null,
        wallet_id uuid not null references wallets (id),
        player_id uuid not null,
        round_id text not null,
        game_id text not null,
        kind text not null check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount numeric(20, 2) not null check (amount >= 0),
        currency char(3) not null,
        reference_external_transaction_id text,
        reference_transaction_id uuid references wager_transactions (id),
        status text not null check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code text,
        observed_balance numeric(20, 2),
        created_at timestamptz not null,
        processed_at timestamptz,
        updated_at timestamptz not null,
        constraint wager_transactions_idempotency_key_unique unique (idempotency_key),
        constraint wager_transactions_provider_external_unique unique (provider_id, external_transaction_id),
        constraint wager_transactions_reversal_needs_reference check (
          kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null
        ),
        constraint wager_transactions_failure_code_on_failure check (
          (status in ('REJECTED', 'FAILED')) = (failure_code is not null)
        ),
        constraint wager_transactions_processed_has_reference check (
          status <> 'PROCESSED' or kind not in ('REFUND', 'ROLLBACK') or reference_transaction_id is not null
        )
      );
    `);
    // Reversals are looked up by the provider's id, scoped to the provider.
    this.addSql(`
      create index wager_transactions_reference_idx
        on wager_transactions (provider_id, reference_external_transaction_id)
        where reference_external_transaction_id is not null;
    `);
    this.addSql(`
      create unique index wager_transactions_single_reversal_per_kind
        on wager_transactions (reference_transaction_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');
    `);
    this.addSql(`
      create index wager_transactions_pending_reference_idx
        on wager_transactions (created_at)
        where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      create function wager_transactions_guard_terminal() returns trigger
      language plpgsql as $$
      begin
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager transaction % is terminal (%)', old.id, old.status
            using errcode = 'restrict_violation';
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger wager_transactions_terminal_is_final
        before update on wager_transactions
        for each row execute function wager_transactions_guard_terminal();
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        seq bigint generated always as identity,
        wallet_id uuid not null references wallets (id),
        transaction_id uuid not null references wager_transactions (id),
        direction text not null check (direction in ('DEBIT', 'CREDIT')),
        amount numeric(20, 2) not null check (amount > 0),
        currency char(3) not null,
        balance_before numeric(20, 2) not null check (balance_before >= 0),
        balance_after numeric(20, 2) not null check (balance_after >= 0),
        created_at timestamptz not null,
        constraint wallet_ledger_entries_one_per_transaction unique (transaction_id),
        constraint wallet_ledger_entries_seq_unique unique (seq),
        constraint wallet_ledger_entries_balanced check (
          (direction = 'CREDIT' and balance_after = balance_before + amount)
          or (direction = 'DEBIT' and balance_after = balance_before - amount)
        )
      );
    `);
    // Stable cursor pagination per wallet.
    this.addSql(`create index wallet_ledger_entries_wallet_seq_idx on wallet_ledger_entries (wallet_id, seq);`);
    this.addSql(`
      create function wallet_ledger_entries_append_only() returns trigger
      language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only (% blocked)', tg_op
          using errcode = 'restrict_violation';
      end;
      $$;
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_update_delete
        before update or delete on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_append_only();
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function wallet_ledger_entries_append_only();
    `);

    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash char(64) not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        primary key (consumer_name, message_id)
      );
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        seq bigint generated always as identity,
        aggregate_id uuid not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0 check (attempts >= 0),
        next_attempt_at timestamptz not null,
        published_at timestamptz
      );
    `);
    this.addSql(`
      create index outbox_messages_due_idx
        on outbox_messages (next_attempt_at, seq)
        where published_at is null;
    `);
  }

  override down(): void {
    this.addSql('drop table if exists outbox_messages;');
    this.addSql('drop table if exists inbox_messages;');
    this.addSql('drop table if exists wallet_ledger_entries;');
    this.addSql('drop function if exists wallet_ledger_entries_append_only();');
    this.addSql('drop table if exists wager_transactions;');
    this.addSql('drop function if exists wager_transactions_guard_terminal();');
    this.addSql('drop table if exists wallets;');
  }
}
