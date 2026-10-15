import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@penai/shared";
import {
  createDb, createInboxQuickReply, deleteInboxQuickReply, listInboxQuickReplies,
  updateInboxQuickReply, type DbHandle,
} from "../src/index.js";
import { createTestFixtures, setupTestDatabase, TEST_APP_URL, type TestFixtures } from "../src/testing.js";

let dbh: DbHandle;
let fx: TestFixtures;
const ctxA = (): WorkspaceContext => ({ workspaceId: fx.wsA, userId: fx.userId, role: "ws_admin" });
const ctxB = (): WorkspaceContext => ({ workspaceId: fx.wsB, userId: fx.userId, role: "ws_admin" });

beforeAll(async () => { await setupTestDatabase(); fx = await createTestFixtures(); dbh = createDb(TEST_APP_URL); });
afterAll(async () => { await dbh?.close(); });

describe("Inbox quick replies", () => {
  it("saves, edits and deletes templates within one workspace only", async () => {
    const a = await createInboxQuickReply(dbh.db, ctxA(), "gia", "Báo giá", "Giá chậu này là ...");
    expect(a).toMatchObject({ shortcut: "gia", title: "Báo giá" });
    expect(await createInboxQuickReply(dbh.db, ctxA(), "gia", "Trùng", "Khác")).toBeNull();
    expect(await listInboxQuickReplies(dbh.db, ctxB())).toEqual([]);
    const b = await createInboxQuickReply(dbh.db, ctxB(), "gia", "Giá B", "Giá workspace B");
    expect(b?.id).not.toBe(a?.id);
    expect(await updateInboxQuickReply(dbh.db, ctxB(), a!.id, "gia", "Sai quyền", "Không đổi")).toBeNull();
    expect(await deleteInboxQuickReply(dbh.db, ctxB(), a!.id)).toBe(false);
    expect(await updateInboxQuickReply(dbh.db, ctxA(), a!.id, "gia-moi", "Giá mới", "Nội dung mới"))
      .toMatchObject({ shortcut: "gia-moi", content: "Nội dung mới" });
    expect(await listInboxQuickReplies(dbh.db, ctxA())).toHaveLength(1);
    expect(await deleteInboxQuickReply(dbh.db, ctxA(), a!.id)).toBe(true);
    expect(await listInboxQuickReplies(dbh.db, ctxA())).toEqual([]);
    expect(await listInboxQuickReplies(dbh.db, ctxB())).toHaveLength(1);
  });
});
