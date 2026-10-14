import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@penai/shared";
import {
  createDb,
  createChannel,
  listChannels,
  listEnabledChannels,
  createSession,
  getChannelSession,
  mapChannelSession,
  createPairing,
  isPaired,
  approvePairing,
  approveObservedZaloThread,
  listPendingPairings,
  upsertInboxObservedPeer,
  listInboxObservedPeers,
  setInboxObservedPeerReview,
  upsertContact,
  listContacts,
  type DbHandle,
} from "../src/index.js";
import {
  createTestFixtures,
  setupTestDatabase,
  TEST_APP_URL,
  type TestFixtures,
} from "../src/testing.js";

let fx: TestFixtures;
let dbh: DbHandle;
const ctxA = (): WorkspaceContext => ({ workspaceId: fx.wsA, userId: fx.userId, role: "ws_admin" });
const ctxB = (): WorkspaceContext => ({ workspaceId: fx.wsB, userId: fx.userId, role: "ws_admin" });

beforeAll(async () => {
  await setupTestDatabase();
  fx = await createTestFixtures();
  dbh = createDb(TEST_APP_URL);
});
afterAll(async () => {
  await dbh.close();
});

describe("channels + pairing + contacts (RLS)", () => {
  it("tạo channel + list scoped theo workspace", async () => {
    const ch = await createChannel(dbh.db, ctxA(), {
      kind: "telegram",
      name: "Bot kế toán",
      agentId: fx.agentA,
      tokenEncrypted: "v1.fake",
    });
    expect(ch.id).toBeTruthy();

    const inA = await listChannels(dbh.db, ctxA());
    expect(inA.map((c) => c.id)).toContain(ch.id);
    const inB = await listChannels(dbh.db, ctxB());
    expect(inB.map((c) => c.id)).not.toContain(ch.id); // cách ly
  });

  it("listEnabledChannels thấy channel enabled (dùng lúc boot)", async () => {
    const all = await listEnabledChannels(dbh.db);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((c) => c.workspaceId)).toBe(true);
  });

  it("ánh xạ chat → session", async () => {
    const chans = await listChannels(dbh.db, ctxA());
    const ch = chans[0]!;
    const s = await createSession(dbh.db, ctxA(), { agentId: fx.agentA });
    expect(await getChannelSession(dbh.db, ctxA(), ch.id, "chat-123")).toBeNull();
    await mapChannelSession(dbh.db, ctxA(), ch.id, "chat-123", s.id);
    expect(await getChannelSession(dbh.db, ctxA(), ch.id, "chat-123")).toBe(s.id);
  });

  it("pairing: chưa duyệt → not paired; duyệt → paired", async () => {
    const ch = (await listChannels(dbh.db, ctxA()))[0]!;
    expect(await isPaired(dbh.db, ctxA(), ch.id, "user-9")).toBe(false);
    await createPairing(dbh.db, ctxA(), ch.id, "ABCD2345", "user-9");
    expect(await isPaired(dbh.db, ctxA(), ch.id, "user-9")).toBe(false); // pending
    const approved = await approvePairing(dbh.db, ctxA(), ch.id, "ABCD2345");
    expect(approved?.externalUserId).toBe("user-9");
    expect(await isPaired(dbh.db, ctxA(), ch.id, "user-9")).toBe(true);
  });

  it("chỉ giữ một yêu cầu đang chờ cho mỗi người trên mỗi kênh", async () => {
    const ch = (await listChannels(dbh.db, ctxA()))[0]!;
    const first = await createPairing(dbh.db, ctxA(), ch.id, "FIRST123", "repeat-user");
    const second = await createPairing(dbh.db, ctxA(), ch.id, "SECOND12", "repeat-user");
    expect(first).toEqual({ code: "FIRST123", created: true });
    expect(second).toEqual({ code: "FIRST123", created: false });
    expect((await listPendingPairings(dbh.db, ctxA())).filter((p) => p.externalUserId === "repeat-user")).toHaveLength(1);
    await approvePairing(dbh.db, ctxA(), ch.id, "FIRST123");
    expect((await listPendingPairings(dbh.db, ctxA())).filter((p) => p.externalUserId === "repeat-user")).toHaveLength(0);
  });

  it("duyệt hội thoại Zalo một lần: DM có pairing ngay, nhóm chỉ mở thread", async () => {
    const ch = await createChannel(dbh.db, ctxA(), {
      kind: "zalo_personal", name: "Zalo thử nghiệm", agentId: fx.agentA,
    });
    for (const [kind, uid] of [["direct", "123"], ["group", "456"]] as const) {
      await upsertInboxObservedPeer(dbh.db, ctxA(), ch.id, {
        chatKey: `${kind}:${uid}`, threadId: uid, kind, name: uid,
        lastSenderId: uid, lastSenderName: uid, countMessage: true,
      });
    }
    await createPairing(dbh.db, ctxA(), ch.id, "PENDING123", "123");
    expect(await approveObservedZaloThread(dbh.db, ctxB(), ch.id, "direct:123")).toBeNull();
    expect(await approveObservedZaloThread(dbh.db, ctxA(), ch.id, "direct:999")).toBeNull();
    const direct = await approveObservedZaloThread(dbh.db, ctxA(), ch.id, "direct:123");
    expect(direct?.demoThreads).toContain("direct:123");
    expect(await isPaired(dbh.db, ctxA(), ch.id, "123")).toBe(true);
    expect((await listPendingPairings(dbh.db, ctxA())).filter((p) => p.externalUserId === "123")).toHaveLength(0);
    expect(await createPairing(dbh.db, ctxA(), ch.id, "LATE123", "123"))
      .toEqual({ code: "", created: false });
    const group = await approveObservedZaloThread(dbh.db, ctxA(), ch.id, "group:456");
    expect(group?.demoThreads).toEqual(["direct:123", "group:456"]);
    expect(await isPaired(dbh.db, ctxA(), ch.id, "456")).toBe(false);
    expect((await approveObservedZaloThread(dbh.db, ctxA(), ch.id, "direct:123"))?.demoThreads)
      .toEqual(["direct:123", "group:456"]);
  });

  it("ẩn và đánh dấu không cần duyệt theo từng kênh, tin mới không xóa dấu", async () => {
    const ch = await createChannel(dbh.db, ctxA(), {
      kind: "zalo_personal", name: "Zalo phân loại", agentId: fx.agentA,
    });
    for (const id of ["701", "702"]) await upsertInboxObservedPeer(dbh.db, ctxA(), ch.id, {
      chatKey: `direct:${id}`, threadId: id, kind: "direct", name: `Khách ${id}`,
      lastSenderId: id, lastSenderName: `Khách ${id}`, countMessage: true,
    });
    expect(await setInboxObservedPeerReview(dbh.db, ctxB(), ch.id, "direct:701", { hiddenInPending: true })).toBeNull();
    expect(await setInboxObservedPeerReview(dbh.db, ctxA(), ch.id, "direct:701", { hiddenInPending: true }))
      .toMatchObject({ hiddenInPending: true, noApprovalNeeded: false });
    expect(await setInboxObservedPeerReview(dbh.db, ctxA(), ch.id, "direct:702", { noApprovalNeeded: true }))
      .toMatchObject({ hiddenInPending: false, noApprovalNeeded: true });
    await upsertInboxObservedPeer(dbh.db, ctxA(), ch.id, {
      chatKey: "direct:701", threadId: "701", kind: "direct", name: "Khách 701 mới",
      lastSenderId: "701", lastSenderName: "Khách 701 mới", countMessage: true,
    });
    expect(await listInboxObservedPeers(dbh.db, ctxA(), ch.id, { review: "pending" })).toHaveLength(0);
    expect((await listInboxObservedPeers(dbh.db, ctxA(), ch.id, { review: "hidden" }))[0]?.name)
      .toBe("Khách 701 mới");
    expect((await listInboxObservedPeers(dbh.db, ctxA(), ch.id, { review: "not_needed" }))[0]?.chatKey)
      .toBe("direct:702");
    expect(await listInboxObservedPeers(dbh.db, ctxA(), ch.id, { review: "all" })).toHaveLength(2);
  });

  it("mã hết hạn không hiện chờ duyệt và không được duyệt", async () => {
    const ch = (await listChannels(dbh.db, ctxA()))[0]!;
    await createPairing(dbh.db, ctxA(), ch.id, "EXPIRED1", "expired-user", -1);
    expect((await listPendingPairings(dbh.db, ctxA())).filter((p) => p.externalUserId === "expired-user")).toHaveLength(0);
    expect(await approvePairing(dbh.db, ctxA(), ch.id, "EXPIRED1")).toBeNull();
    expect(await createPairing(dbh.db, ctxA(), ch.id, "RENEW123", "expired-user"))
      .toEqual({ code: "RENEW123", created: true });
  });

  it("contacts upsert + dedup theo (workspace, kind, external_id)", async () => {
    await upsertContact(dbh.db, ctxA(), { channelKind: "telegram", externalId: "u1", displayName: "An" });
    await upsertContact(dbh.db, ctxA(), { channelKind: "telegram", externalId: "u1", displayName: "An Nguyen" });
    const list = await listContacts(dbh.db, ctxA());
    const u1 = list.filter((c) => c.externalId === "u1");
    expect(u1).toHaveLength(1); // dedup
    expect(u1[0]!.displayName).toBe("An Nguyen"); // cập nhật
  });
});
