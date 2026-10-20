import { Migration } from '@mikro-orm/migrations';

/** Retry bookkeeping for reversals waiting on their reference (PENDING_REFERENCE). */
export class Migration0002PendingReferenceRetries extends Migration {
  override up(): void {
    this.addSql(`
      alter table wager_transactions
        add column reference_attempts integer not null default 0 check (reference_attempts >= 0),
        add column next_reference_attempt_at timestamptz;
    `);
    this.addSql('drop index if exists wager_transactions_pending_reference_idx;');
    this.addSql(`
      create index wager_transactions_pending_reference_due_idx
        on wager_transactions (next_reference_attempt_at)
        where status = 'PENDING_REFERENCE';
    `);
  }

  override down(): void {
    this.addSql('drop index if exists wager_transactions_pending_reference_due_idx;');
    this.addSql(`
      create index wager_transactions_pending_reference_idx
        on wager_transactions (created_at)
        where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      alter table wager_transactions
        drop column next_reference_attempt_at,
        drop column reference_attempts;
    `);
  }
}
