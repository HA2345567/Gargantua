import type { PoolClient } from "pg";

export interface Ledger {
  lockStake(client: PoolClient, input: { userId: string; amount: string; parlayId: string; quoteNonce: string }): Promise<void>;
  credit(client: PoolClient, input: { userId: string; amount: string; parlayId: string; kind: "payout" | "refund" }): Promise<void>;
}

export class PostgresVirtualLedger implements Ledger {
  async lockStake(client: PoolClient, input: { userId: string; amount: string; parlayId: string; quoteNonce: string }): Promise<void> {
    const update = await client.query("UPDATE users SET balance=balance-$2 WHERE id=$1 AND balance >= $2", [input.userId, input.amount]);
    if (update.rowCount !== 1) throw Object.assign(new Error("insufficient virtual balance"), { code: "insufficient_balance" });
    await client.query("INSERT INTO ledger_entries (user_id,kind,amount,parlay_id,idempotency_key) VALUES ($1,'stake',-($2::numeric),$3,$4)", [input.userId, input.amount, input.parlayId, `stake:${input.quoteNonce}`]);
  }

  async credit(client: PoolClient, input: { userId: string; amount: string; parlayId: string; kind: "payout" | "refund" }): Promise<void> {
    const inserted = await client.query<{ id: string }>("INSERT INTO ledger_entries (user_id,kind,amount,parlay_id,idempotency_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id", [input.userId, input.kind, input.amount, input.parlayId, `settlement:${input.parlayId}`]);
    if (!inserted.rowCount) return;
    await client.query("UPDATE users SET balance=balance+$2 WHERE id=$1", [input.userId, input.amount]);
  }
}
