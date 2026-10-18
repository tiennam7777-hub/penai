import { sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";

export interface AccountingBuyerInfo {
  taxCode: string;
  companyName: string;
  address: string;
  email: string;
}

export async function claimMisaAccountingNotice(db: Db, ctx: WorkspaceContext, input: {
  channelId: string; threadId: string; eventKey: string;
  kind: "draft_saved" | "issued" | "missing_info" | "increase_request";
  groupId: string; message: string; refId?: string;
}): Promise<string | null> {
  const result = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    INSERT INTO misa_accounting_notifications
      (workspace_id, source_channel_id, source_thread_id, event_key, kind, target_thread_id, message, misa_ref_id)
    VALUES (${ctx.workspaceId}, ${input.channelId}, ${input.threadId}, ${input.eventKey},
      ${input.kind}, ${input.groupId}, ${input.message}, ${input.refId ?? null})
    ON CONFLICT (workspace_id, source_channel_id, source_thread_id, event_key) DO NOTHING
    RETURNING id`));
  return result.rows[0]?.id ? String(result.rows[0].id) : null;
}

export async function finishMisaAccountingNotice(db: Db, ctx: WorkspaceContext, id: string,
  result: { messageId: string } | { error: string }): Promise<void> {
  await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    UPDATE misa_accounting_notifications SET
      status = ${"messageId" in result ? "sent" : "failed"},
      group_message_id = ${"messageId" in result ? result.messageId : null},
      error = ${"error" in result ? result.error.slice(0, 500) : null}, updated_at = now()
    WHERE workspace_id = ${ctx.workspaceId} AND id = ${id}`));
}

export async function pendingMisaAccountingRequest(db: Db, ctx: WorkspaceContext,
  channelId: string, groupId: string, quotedMessageId: string): Promise<boolean> {
  const result = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    SELECT 1 FROM misa_accounting_notifications
    WHERE workspace_id = ${ctx.workspaceId} AND source_channel_id = ${channelId}
      AND target_thread_id = ${groupId} AND group_message_id = ${quotedMessageId}
      AND kind = 'missing_info' AND status = 'sent' AND response_message_id IS NULL LIMIT 1`));
  return result.rows.length > 0;
}

/** Only a reply quoting the exact accounting-group notice may update the linked customer. */
export async function applyMisaAccountingReply(db: Db, ctx: WorkspaceContext, input: {
  channelId: string; groupId: string; quotedMessageId: string; responseMessageId: string;
  buyer: AccountingBuyerInfo;
}): Promise<{ threadId: string } | null> {
  return withWorkspace(db, ctx, async (tx) => {
    const claimed = await tx.execute(sql`
      UPDATE misa_accounting_notifications SET
        response_message_id = ${input.responseMessageId},
        buyer_tax_code = ${input.buyer.taxCode}, buyer_company_name = ${input.buyer.companyName},
        buyer_address = ${input.buyer.address}, buyer_email = ${input.buyer.email}, updated_at = now()
      WHERE workspace_id = ${ctx.workspaceId} AND source_channel_id = ${input.channelId}
        AND target_thread_id = ${input.groupId} AND group_message_id = ${input.quotedMessageId}
        AND kind = 'missing_info' AND status = 'sent' AND response_message_id IS NULL
      RETURNING source_thread_id`);
    const threadId = claimed.rows[0]?.source_thread_id;
    if (!threadId) return null;
    const noteLine = `[Thông tin XHD do nhóm Kế Toán Orchids World cung cấp] MST: ${input.buyer.taxCode}; Công ty: ${input.buyer.companyName}; Địa chỉ: ${input.buyer.address}${input.buyer.email ? `; Email: ${input.buyer.email}` : ""}.`;
    await tx.execute(sql`
      UPDATE inbox_threads SET
        customer_note = right(concat_ws(E'\n', nullif(customer_note, ''), ${noteLine}), 10000),
        customer_note_updated_at = now()
      WHERE workspace_id = ${ctx.workspaceId} AND channel_id = ${input.channelId}
        AND thread_id = ${String(threadId)} AND kind = 'direct'`);
    return { threadId: String(threadId) };
  });
}

export async function latestMisaAccountingBuyer(db: Db, ctx: WorkspaceContext,
  channelId: string, threadId: string): Promise<AccountingBuyerInfo | null> {
  const result = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    SELECT buyer_tax_code, buyer_company_name, buyer_address, buyer_email
    FROM misa_accounting_notifications
    WHERE workspace_id = ${ctx.workspaceId} AND source_channel_id = ${channelId}
      AND source_thread_id = ${threadId} AND kind = 'missing_info'
      AND response_message_id IS NOT NULL
    ORDER BY updated_at DESC LIMIT 1`));
  const row = result.rows[0];
  return row ? { taxCode: String(row.buyer_tax_code), companyName: String(row.buyer_company_name),
    address: String(row.buyer_address), email: String(row.buyer_email ?? "") } : null;
}
