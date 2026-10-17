import { eq } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";
import { kiotvietCredentials } from "./schema.js";

export type KiotVietCredentialsRow = typeof kiotvietCredentials.$inferSelect;

export async function getKiotVietCredentials(db: Db, ctx: WorkspaceContext): Promise<KiotVietCredentialsRow | null> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.select().from(kiotvietCredentials).where(eq(kiotvietCredentials.workspaceId, ctx.workspaceId)).limit(1),
  );
  return rows[0] ?? null;
}

export async function saveKiotVietCredentials(
  db: Db,
  ctx: WorkspaceContext,
  values: Omit<typeof kiotvietCredentials.$inferInsert, "workspaceId" | "updatedAt">,
): Promise<KiotVietCredentialsRow> {
  const rows = await withWorkspace(db, ctx, (tx) =>
    tx.insert(kiotvietCredentials)
      .values({ workspaceId: ctx.workspaceId, ...values })
      .onConflictDoUpdate({
        target: kiotvietCredentials.workspaceId,
        set: { ...values, updatedAt: new Date() },
      }).returning(),
  );
  return rows[0]!;
}

export async function setKiotVietCashier(
  db: Db, ctx: WorkspaceContext, userId: number, username: string,
): Promise<KiotVietCredentialsRow | null> {
  const rows = await withWorkspace(db, ctx, (tx) => tx.update(kiotvietCredentials)
    .set({ cashierUserId: userId, cashierUsername: username, updatedAt: new Date() })
    .where(eq(kiotvietCredentials.workspaceId, ctx.workspaceId)).returning());
  return rows[0] ?? null;
}
