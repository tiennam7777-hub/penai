import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import { claimOrchidOrderDispatch, claimOrchidOrderReport, createChannel, createDb, recordInboxMessage,
  type DbHandle, withWorkspace } from "../src/index.js";
import { createTestFixtures, setupTestDatabase, TEST_APP_URL, type TestFixtures } from "../src/testing.js";

let dbh: DbHandle;
let fx: TestFixtures;
let channelId: string;
const ctx = (): WorkspaceContext => ({ workspaceId: fx.wsA, userId: fx.userId, role: "ws_admin" });
const input = (threadId: string, message: string) => ({
  channelId, threadId, targetThreadId: "flower-group", message,
});

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
  channelId = (await createChannel(dbh.db, ctx(), {
    kind: "zalo_personal", name: "Hot 1", agentId: fx.agentA,
  })).id;
});
afterAll(async () => { await dbh?.close(); });

describe("orchid order report once per conversation", () => {
  it("keeps the first report when time, price or colour changes; /new starts another order", async () => {
    const threadId = "order-report-updates";
    const first = await claimOrchidOrderReport(dbh.db, ctx(), input(threadId, "10 cành vàng, 9h, chưa chốt giá"));
    expect(first).toBeTruthy();
    expect(await claimOrchidOrderReport(dbh.db, ctx(), input(threadId, "10 cành hồng, 10h, 1.600.000đ"))).toBeNull();
    await withWorkspace(dbh.db, ctx(), (tx) => tx.execute(sql`
      UPDATE orchid_order_dispatches SET created_at = '2020-01-01T00:00:00Z' WHERE id = ${first}`));
    await recordInboxMessage(dbh.db, ctx(), channelId, {
      threadId, peerKind: "direct", msgId: "reset-order-report", direction: "in", source: "zalo",
      senderId: threadId, senderName: "Anh Nam", contentType: "text", text: "/new",
      sentAt: new Date(), threadName: "Anh Nam",
    });
    const second = await claimOrchidOrderReport(dbh.db, ctx(), input(threadId, "đơn mới 5 cành xanh"));
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(await claimOrchidOrderReport(dbh.db, ctx(), input(threadId, "đơn mới đổi giờ"))).toBeNull();
    expect(await claimOrchidOrderDispatch(dbh.db, ctx(), {
      ...input(threadId, "khách hủy đơn"), fingerprint: "cancel:message-1",
    })).toBeTruthy();
  });

  it("recognises an earlier report keyed by its old details fingerprint", async () => {
    const threadId = "legacy-order-report";
    const legacy = await claimOrchidOrderDispatch(dbh.db, ctx(), {
      ...input(threadId, "đơn cũ"), fingerprint: "a".repeat(64),
    });
    expect(legacy).toBeTruthy();
    expect(await claimOrchidOrderReport(dbh.db, ctx(), input(threadId, "đổi màu và giá"))).toBeNull();
  });
});
