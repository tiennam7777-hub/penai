import { sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";

export async function getOrchidShippingMaps(db: Db, ctx: WorkspaceContext) {
  const result = await withWorkspace(db, ctx, tx => tx.execute(sql`
    SELECT api_key_encrypted, daily_limit,
      CASE WHEN usage_day = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN usage_count ELSE 0 END AS usage_count
    FROM orchid_shipping_maps WHERE workspace_id = ${ctx.workspaceId}`));
  const r = result.rows[0];
  return r ? { apiKeyEncrypted: String(r.api_key_encrypted), dailyLimit: Number(r.daily_limit), usageCount: Number(r.usage_count) } : null;
}

export async function saveOrchidShippingMaps(db: Db, ctx: WorkspaceContext, apiKeyEncrypted: string, dailyLimit: number) {
  await withWorkspace(db, ctx, tx => tx.execute(sql`
    INSERT INTO orchid_shipping_maps (workspace_id, api_key_encrypted, daily_limit)
    VALUES (${ctx.workspaceId}, ${apiKeyEncrypted}, ${dailyLimit})
    ON CONFLICT (workspace_id) DO UPDATE SET api_key_encrypted = EXCLUDED.api_key_encrypted,
      daily_limit = EXCLUDED.daily_limit, updated_at = now()`));
}

/** Reserve atomically before requesting Google, including concurrent channels. */
export async function reserveOrchidShippingMapRequest(db: Db, ctx: WorkspaceContext): Promise<boolean> {
  const result = await withWorkspace(db, ctx, tx => tx.execute(sql`
    UPDATE orchid_shipping_maps SET
      usage_count = CASE WHEN usage_day = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN usage_count + 1 ELSE 1 END,
      usage_day = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
    WHERE workspace_id = ${ctx.workspaceId} AND
      (usage_day <> (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date OR usage_count < daily_limit)
    RETURNING workspace_id`));
  return result.rows.length === 1;
}
