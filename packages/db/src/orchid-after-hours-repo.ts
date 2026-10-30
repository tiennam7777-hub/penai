import { sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";

export interface OrchidAfterHoursState { active: boolean; activationId: string | null; updatedAt: string | null }

export async function getOrchidAfterHours(db: Db, ctx: WorkspaceContext): Promise<OrchidAfterHoursState> {
  const res = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    SELECT active, activation_id, updated_at FROM orchid_after_hours
    WHERE workspace_id = ${ctx.workspaceId}`));
  const row = res.rows[0];
  return row ? { active: row.active === true, activationId: String(row.activation_id),
    updatedAt: new Date(String(row.updated_at)).toISOString() }
    : { active: false, activationId: null, updatedAt: null };
}

export async function setOrchidAfterHours(db: Db, ctx: WorkspaceContext, active: boolean): Promise<OrchidAfterHoursState> {
  const res = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    INSERT INTO orchid_after_hours (workspace_id, active, updated_by)
    VALUES (${ctx.workspaceId}, ${active}, ${ctx.userId})
    ON CONFLICT (workspace_id) DO UPDATE SET
      active = EXCLUDED.active,
      activation_id = CASE WHEN orchid_after_hours.active = false AND EXCLUDED.active = true
        THEN gen_random_uuid() ELSE orchid_after_hours.activation_id END,
      updated_at = CASE WHEN orchid_after_hours.active IS DISTINCT FROM EXCLUDED.active
        THEN now() ELSE orchid_after_hours.updated_at END,
      updated_by = EXCLUDED.updated_by
    RETURNING active, activation_id, updated_at`));
  const row = res.rows[0]!;
  return { active: row.active === true, activationId: String(row.activation_id),
    updatedAt: new Date(String(row.updated_at)).toISOString() };
}

/** Claim once per customer per activation, before any Zalo send. An uncertain send is never retried. */
export async function claimOrchidAfterHoursGreeting(db: Db, ctx: WorkspaceContext, input: {
  activationId: string; channelId: string; threadId: string;
}): Promise<boolean> {
  const res = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    INSERT INTO orchid_after_hours_greetings (workspace_id, activation_id, channel_id, thread_id)
    SELECT ${ctx.workspaceId}, ${input.activationId}, ${input.channelId}, ${input.threadId}
    WHERE EXISTS (SELECT 1 FROM orchid_after_hours
      WHERE workspace_id = ${ctx.workspaceId} AND active = true AND activation_id = ${input.activationId})
    ON CONFLICT DO NOTHING RETURNING thread_id`));
  return res.rows.length > 0;
}

export async function finishOrchidAfterHoursGreeting(db: Db, ctx: WorkspaceContext, input: {
  activationId: string; channelId: string; threadId: string; messageId?: string;
}): Promise<void> {
  await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    UPDATE orchid_after_hours_greetings SET status = ${input.messageId ? "sent" : "failed"},
      message_id = ${input.messageId ?? null}, updated_at = now()
    WHERE workspace_id = ${ctx.workspaceId} AND activation_id = ${input.activationId}
      AND channel_id = ${input.channelId} AND thread_id = ${input.threadId}`));
}

export async function getOrchidAfterHoursGreetingStatus(db: Db, ctx: WorkspaceContext, input: {
  activationId: string; channelId: string; threadId: string;
}): Promise<"sending" | "sent" | "failed" | null> {
  const res = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    SELECT status FROM orchid_after_hours_greetings
    WHERE workspace_id = ${ctx.workspaceId} AND activation_id = ${input.activationId}
      AND channel_id = ${input.channelId} AND thread_id = ${input.threadId}`));
  const status = res.rows[0]?.status;
  return status === "sending" || status === "sent" || status === "failed" ? status : null;
}
