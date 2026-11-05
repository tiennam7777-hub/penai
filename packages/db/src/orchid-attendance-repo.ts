import { sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";

export interface OrchidAttendanceRow {
  code: string;
  name: string;
  archived: boolean;
  source: string;
  shiftRows: number;
  totals: Record<string, string>;
}

export async function listOrchidAttendanceImports(db: Db, ctx: WorkspaceContext, month: string) {
  const result = await withWorkspace(db, ctx, tx => tx.execute(sql`
    SELECT branch_id, branch_name, source_filename, source_sha256, imported_at, rows
    FROM orchid_attendance_imports
    WHERE workspace_id = ${ctx.workspaceId} AND month = ${month}
    ORDER BY CASE branch_id WHEN '42' THEN 1 WHEN '188' THEN 2 ELSE 3 END`));
  return result.rows.map(row => ({
    branchId: String(row.branch_id),
    branchName: String(row.branch_name),
    sourceFilename: String(row.source_filename),
    sourceSha256: String(row.source_sha256),
    importedAt: new Date(String(row.imported_at)).toISOString(),
    rows: row.rows as OrchidAttendanceRow[],
  }));
}

export async function getOrchidAttendanceFile(db: Db, ctx: WorkspaceContext, month: string, branchId: string) {
  const result = await withWorkspace(db, ctx, tx => tx.execute(sql`
    SELECT source_filename, source_file FROM orchid_attendance_imports
    WHERE workspace_id = ${ctx.workspaceId} AND month = ${month} AND branch_id = ${branchId}`));
  const row = result.rows[0];
  return row ? { filename: String(row.source_filename), bytes: row.source_file as Buffer } : null;
}
