import { sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";
import { listOrchidStemMessages } from "./orchid-stem-report-repo.js";

/** Reuse cross-account deduplication, recall exclusion and quote context. */
export async function listOrchidQualityMessages(db: Db, ctx: WorkspaceContext, start: Date, end: Date) {
  const result = await withWorkspace(db, ctx, tx => tx.execute(sql`
    SELECT t.channel_id, t.thread_id FROM inbox_threads t JOIN channels c ON c.id=t.channel_id
    WHERE t.workspace_id=${ctx.workspaceId} AND t.kind='group' AND c.kind='zalo_personal'
      AND t.name='Di Hoa Xau - Nhet Cay 2 nhanh'
    ORDER BY CASE WHEN c.name='NV Bán Hàng Hot 1' THEN 0 ELSE 1 END, t.channel_id LIMIT 1`));
  const anchor = result.rows[0];
  if (!anchor) return { found: false, messages: [] };
  return { found: true, messages: await listOrchidStemMessages(db, ctx,
    String(anchor.channel_id), String(anchor.thread_id), start, end) };
}
