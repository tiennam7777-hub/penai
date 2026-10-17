import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadType } from "zca-js";
import type { ChannelContact, ChannelMessageLog, ChannelReaction } from "../src/types.js";
import { describeZaloContent, parseAutoReaction, ZALO_REACTIONS, ZaloPersonalChannel, zaloSharedContactPhone } from "../src/zalo-personal.js";

describe("describeZaloContent — nội dung tin cho Inbox", () => {
  it("text thường", () => {
    expect(describeZaloContent("xin chào", "webchat")).toEqual({ contentType: "text", text: "xin chào" });
  });

  it("ảnh từ CDN Zalo giữ link, link lạ bị bỏ", () => {
    const ok = describeZaloContent(
      { href: "https://f47-photo.talk.zdn.vn/a.jpg", thumb: "https://f47-photo.talk.zdn.vn/t.jpg", title: "chú thích" },
      "chat.photo",
    );
    expect(ok.contentType).toBe("photo");
    expect(ok.text).toBe("chú thích");
    expect(ok.media?.url).toBe("https://f47-photo.talk.zdn.vn/a.jpg");
    const bad = describeZaloContent({ href: "https://evil.example/a.jpg" }, "chat.photo");
    expect(bad.media?.url).toBeUndefined();
  });

  it("file giữ tên + đuôi + dung lượng", () => {
    const f = describeZaloContent(
      { href: "https://f18-zpg.zdn.vn/x", title: "bao-gia", params: JSON.stringify({ fileExt: "xlsx", fileSize: 1234 }) },
      "share.file",
    );
    expect(f).toMatchObject({ contentType: "file", media: { name: "bao-gia.xlsx", size: 1234 } });
    const zaloFile = describeZaloContent(
      { href: "https://file-stal-15.dlfl.vn/download/123", title: "20-10.xlsx" },
      "share.file",
    );
    expect(zaloFile.media?.url).toBe("https://file-stal-15.dlfl.vn/download/123");
    expect(describeZaloContent({ href: "https://dlfl.vn.evil.example/file", title: "fake.xlsx" }, "share.file").media?.url).toBeUndefined();
  });

  it("thẻ liên hệ Zalo hiển thị cả số điện thoại trong Inbox", () => {
    const card = { title: "Hoai Anh", params: JSON.stringify({ contactUid: "8224189516377002390", phone: "098 231 0386" }) };
    expect(zaloSharedContactPhone(card, "share.contact")).toBe("0982310386");
    expect(describeZaloContent(card, "share.contact")).toMatchObject({ contentType: "other", text: "Hoai Anh · 0982310386" });
    expect(describeZaloContent({ title: "Hoai Anh", description: "+84 98 231 0386" }, "chat.card").text).toContain("0982310386");
    expect(zaloSharedContactPhone({ title: "Hoai Anh", params: '{"phone":"123"}' }, "share.contact")).toBe("");
  });

  it("sticker / voice / nội dung lạ", () => {
    expect(describeZaloContent({ id: 1 }, "chat.sticker").contentType).toBe("sticker");
    expect(describeZaloContent({ href: "https://a.zdn.vn/v.aac" }, "chat.voice").contentType).toBe("voice");
    expect(describeZaloContent({ foo: 1 }, "chat.xyz").contentType).toBe("other");
  });
});

describe("Inbox: ghi tin đi/đến + bỏ bản dội lại", () => {
  it("lưu bản sao file khách gửi từ CDN Zalo trước khi ghi Inbox", async () => {
    const logs: ChannelMessageLog[] = [];
    const saved: Buffer[] = [];
    const channel = new ZaloPersonalChannel({
      id: "zp-file", name: "Zalo", token: "{}", config: {}, requirePairing: true,
      onInbound: async () => ({ kind: "ignore" }),
      onMessageLog: (entry) => logs.push(entry),
      saveInboxFile: async (buf) => { saved.push(buf); return "/workspace/zalo-inbox/file.xlsx"; },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("spreadsheet", { status: 200 }));
    try {
      await (channel as unknown as { logListenerMessage: (...args: unknown[]) => Promise<void> }).logListenerMessage(
        { isSelf: false, data: { msgId: "file-1", msgType: "share.file", content: {
          href: "https://file-stal-15.dlfl.vn/download/123", title: "20-10.xlsx",
        }, ts: String(Date.now()) } }, "group", "g-1", "customer", "Khách",
      );
      expect(saved[0]?.toString()).toBe("spreadsheet");
      expect(logs[0]?.media).toMatchObject({ name: "20-10.xlsx", localPath: "/workspace/zalo-inbox/file.xlsx" });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      fetchMock.mockRestore();
    }
  });

  function setup() {
    const logs: ChannelMessageLog[] = [];
    const contacts: ChannelContact[][] = [];
    const channel = new ZaloPersonalChannel({
      id: "zp-inbox",
      name: "Zalo inbox",
      token: "{}",
      config: {},
      requirePairing: true,
      onInbound: async () => ({ kind: "ignore" }),
      onMessageLog: (e) => logs.push(e),
      onContactsSynced: (items) => { contacts.push(items); },
    });
    let n = 100;
    const sent: Array<{ msg: unknown; threadId: string; type: unknown }> = [];
    const friendRequests: Array<{ message: string; uid: string }> = [];
    const friendStatus = { is_friend: 0, is_requested: 0, is_requesting: 0 };
    const fakeApi = {
      sendMessage: async (msg: unknown, threadId: string, type: unknown) => {
        sent.push({ msg, threadId, type });
        n += 1;
        return { message: { msgId: String(n) }, attachment: [] };
      },
      findUser: async (phone: string) => (phone === "0900000001" ? { uid: "u-1", display_name: "Chị A", avatar: "" } : null),
      findUserByUsername: async (username: string) => (username === "orchids" ? { uid: "u-1", display_name: "Chị A", avatar: "" } : null),
      getFriendRequestStatus: async () => friendStatus,
      sendFriendRequest: async (message: string, uid: string) => { friendRequests.push({ message, uid }); return ""; },
    };
    const c = channel as unknown as Record<string, unknown>;
    c.api = fakeApi;
    c.account = { id: "me-1", name: "Shop" };
    return { channel, logs, sent, contacts, friendRequests, friendStatus };
  }

  it("sendManual gửi text không qua cổng demo, ghi 1 log nguồn web", async () => {
    const { channel, logs, sent } = setup();
    const ids = await channel.sendManual({ threadId: "u-9", peerKind: "direct", text: "chào anh", source: "web", webUserId: "user-1" });
    expect(ids).toEqual(["101"]);
    expect(sent[0]).toMatchObject({ threadId: "u-9", type: ThreadType.User });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ direction: "out", source: "web", webUserId: "user-1", msgId: "101", text: "chào anh" });
  });

  it("sends a quoted reply through Zalo and records its target for Inbox", async () => {
    const { channel, logs, sent } = setup();
    const quote = { msgId: "old-1", cliMsgId: "cli-old-1", uidFrom: "customer", ts: 1790000000000,
      msgType: "chat.photo", content: { href: "https://f47-photo.talk.zdn.vn/photo.jpg" }, propertyExt: "", ttl: 0 };
    await channel.sendManual({ threadId: "u-9", peerKind: "direct", text: "Mẫu này giá 1,6 triệu ạ", source: "web", quote });
    expect(sent[0]?.msg).toMatchObject({ msg: "Mẫu này giá 1,6 triệu ạ", quote });
    expect(logs[0]?.meta).toMatchObject({ quote: { msgId: "old-1", kind: "photo" } });
  });

  it("captures original Zalo photo metadata from the echo of a sent photo", async () => {
    const saved: Array<{ id: string; source: Record<string, unknown> }> = [];
    const channel = new ZaloPersonalChannel({ id: "zp-photo-quote", name: "Zalo", token: "{}", config: {}, requirePairing: true,
      onInbound: async () => ({ kind: "ignore" }),
      onMessageLog: () => {},
      onMessageQuoteSource: (id, source) => saved.push({ id, source }),
    });
    (channel as unknown as { sentMsgIds: Set<string> }).sentMsgIds.add("sent-photo-1");
    await (channel as unknown as { logListenerMessage: (m: unknown, kind: string, thread: string, sender: string, name: string) => Promise<void> }).logListenerMessage({
      type: ThreadType.User, threadId: "customer", isSelf: true,
      data: { msgId: "sent-photo-1", cliMsgId: "cli-photo-1", msgType: "chat.photo", uidFrom: "owner",
        content: { href: "https://f47-photo.talk.zdn.vn/photo.jpg", thumb: "https://f47-photo.talk.zdn.vn/thumb.jpg" }, ts: String(Date.now()) },
    }, "direct", "customer", "owner", "Shop");
    expect(saved).toMatchObject([{ id: "sent-photo-1", source: { msgType: "chat.photo",
      content: { href: "https://f47-photo.talk.zdn.vn/photo.jpg" } } }]);
  });

  it("tin dội lại (isSelf) của tin PenAI vừa gửi không bị ghi lần 2; tin gửi từ điện thoại thì ghi nguồn app", async () => {
    const { channel, logs } = setup();
    await channel.sendManual({ threadId: "g-1", peerKind: "group", text: "thông báo", source: "mcp" });
    const handle = (channel as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage.bind(channel);
    const base = { type: ThreadType.Group, threadId: "g-1", isSelf: true };
    await handle({ ...base, data: { msgId: "101", uidFrom: "0", content: "thông báo", msgType: "webchat", ts: String(Date.now()) } });
    expect(logs).toHaveLength(1);
    await handle({ ...base, data: { msgId: "555", uidFrom: "0", content: "gõ từ điện thoại", msgType: "webchat", ts: String(Date.now()) } });
    expect(logs).toHaveLength(2);
    expect(logs[1]).toMatchObject({ direction: "out", source: "app", text: "gõ từ điện thoại", peerKind: "group" });
  }, 10_000);

  it("thu hồi -ld từ điện thoại trước khi giao AI và không lưu mã lệnh vào Inbox", async () => {
    const logs: ChannelMessageLog[] = [];
    const order: string[] = [];
    const channel = new ZaloPersonalChannel({
      id: "zp-staff", name: "Hot 1", token: "{}", config: {}, requirePairing: true,
      onInbound: async () => ({ kind: "ignore" }),
      onMessageLog: (entry) => logs.push(entry),
      onSelfCommand: async (threadId) => { order.push(`delegate:${threadId}`); },
    });
    (channel as unknown as { api: unknown }).api = {
      undo: async (_ids: unknown, threadId: string) => { order.push(`recall:${threadId}`); },
    };
    const handle = (channel as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage.bind(channel);
    await handle({ type: ThreadType.User, threadId: "customer", isSelf: true,
      data: { msgId: "cmd-1", cliMsgId: "cli-1", uidFrom: "owner", content: "-ld", msgType: "webchat", ts: String(Date.now()) } });
    expect(order).toEqual(["recall:customer", "delegate:customer"]);
    expect(logs).toEqual([]);
  });

  it("thu hồi -lb và -cn từ điện thoại rồi mới chạy lệnh nội bộ", async () => {
    const logs: ChannelMessageLog[] = [];
    const order: string[] = [];
    const channel = new ZaloPersonalChannel({
      id: "zp-bill", name: "Hot 1", token: "{}", config: {}, requirePairing: true,
      onInbound: async () => ({ kind: "ignore" }),
      onMessageLog: (entry) => logs.push(entry),
      onSelfCommand: async (_threadId, command) => { order.push(`run:${command}`); },
    });
    (channel as unknown as { api: unknown }).api = {
      undo: async () => { order.push("recall"); },
    };
    const handle = (channel as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage.bind(channel);
    for (const command of ["-lb", "-cn"]) {
      await handle({ type: ThreadType.User, threadId: "customer", isSelf: true,
        data: { msgId: `msg-${command}`, cliMsgId: `cli-${command}`, uidFrom: "owner",
          content: command, msgType: "webchat", ts: String(Date.now()) } });
    }
    expect(order).toEqual(["recall", "run:-lb", "recall", "run:-cn"]);
    expect(logs).toEqual([]);
  });

  it("tin khách gửi tới ghi nguồn zalo kèm tên người gửi (kể cả khi agent không được trả lời)", async () => {
    const { channel, logs } = setup();
    const handle = (channel as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage.bind(channel);
    await handle({
      type: ThreadType.User,
      threadId: "u-5",
      isSelf: false,
      data: { msgId: "900", uidFrom: "u-5", dName: "Anh B", content: "còn hàng không?", msgType: "webchat", ts: String(Date.now()) },
    });
    expect(logs[0]).toMatchObject({ direction: "in", source: "zalo", senderName: "Anh B", threadName: "Anh B", threadId: "u-5" });
  });

  it("findUserByPhone trả null khi không có", async () => {
    const { channel } = setup();
    expect(await channel.findUserByPhone("0900000001")).toMatchObject({ uid: "u-1", name: "Chị A" });
    expect(await channel.findUserByPhone("0900000002")).toBeNull();
  });

  it("tìm người và chỉ gửi lời mời khi chưa là bạn/chưa có lời mời", async () => {
    const { channel, logs, friendRequests, friendStatus } = setup();
    expect(await channel.findFriendCandidate("0900000001", "phone")).toMatchObject({ uid: "u-1", name: "Chị A", relationship: "none" });
    expect(await channel.findFriendCandidate("orchids", "username")).toMatchObject({ uid: "u-1", relationship: "none" });
    friendStatus.is_requesting = 1;
    expect(await channel.findFriendCandidate("0900000001", "phone")).toMatchObject({ relationship: "pending" });
    await expect(channel.sendFriendRequest("u-1", "Xin chào")).rejects.toThrow("đang chờ");
    friendStatus.is_requesting = 0;
    friendStatus.is_friend = 1;
    await expect(channel.sendFriendRequest("u-1", "Xin chào")).rejects.toThrow("đã là bạn bè");
    friendStatus.is_friend = 0;
    await channel.sendFriendRequest("u-1", "Xin chào");
    expect(friendRequests).toEqual([{ uid: "u-1", message: "Xin chào" }]);
    expect(logs).toEqual([]);
  });

  it("chưa đăng nhập → sendManual báo NOT_CONNECTED", async () => {
    const channel = new ZaloPersonalChannel({
      id: "zp-x",
      name: "x",
      token: "{}",
      config: {},
      requirePairing: true,
      onInbound: async () => ({ kind: "ignore" }),
    });
    await expect(channel.sendManual({ threadId: "1", peerKind: "direct", text: "a", source: "web" })).rejects.toMatchObject({
      code: "NOT_CONNECTED",
    });
  });
});

it("ảnh kèm câu hỏi được trả lời, còn ảnh không chữ thì im lặng", async () => {
  const sent: string[] = [];
  let inboundMedia: unknown;
  const channel = new ZaloPersonalChannel({
    id: "zp-silent-photo", name: "Zalo", token: "{}", config: { auto_reaction: "heart" },
    requirePairing: false,
    onInbound: async (message, hooks) => {
      inboundMedia = message.media;
      hooks?.onStatus?.("thinking");
      hooks?.onBlockReply?.("Tin trả lời sớm");
      return { kind: "reply", text: "Giá mẫu này là 1,6 triệu ạ." };
    },
  });
  const internals = channel as unknown as Record<string, unknown>;
  internals.api = {
    sendMessage: async (message: { msg: string }) => { sent.push(message.msg); return { message: { msgId: "sent" } }; },
    sendTypingEvent: async () => { sent.push("typing"); },
  };
  internals.account = { id: "me", name: "Shop" };
  internals.isThreadEnabled = () => true;
  internals.collectMedia = async (_content: unknown, msgType: string) =>
    msgType === "chat.file" ? [{ kind: "document", name: "mau.jpg", dataB64: "a" }] : [];
  const handle = (channel as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage.bind(channel);
  await handle({
    type: ThreadType.User, threadId: "customer", isSelf: false,
    data: { msgId: "photo-1", cliMsgId: "cli-1", uidFrom: "customer", dName: "Khách",
      content: { title: "Mẫu này giá bao nhiêu?" }, msgType: "chat.photo", ts: String(Date.now()) },
  });
  expect(inboundMedia).toMatchObject([{ kind: "photo" }]);
  expect(sent).toContain("Tin trả lời sớm");
  expect(sent).toContain("Giá mẫu này là 1,6 triệu ạ.");
  expect(sent).toContain("typing");
  sent.length = 0;
  await handle({
    type: ThreadType.User, threadId: "customer", isSelf: false,
    data: { msgId: "photo-file-2", cliMsgId: "cli-2", uidFrom: "customer", dName: "Khách",
      content: { title: "mau.jpg" }, msgType: "chat.file", ts: String(Date.now()) },
  });
  expect(inboundMedia).toMatchObject([{ kind: "document", name: "mau.jpg" }, { kind: "photo" }]);
  expect(sent).toEqual([]);
});

it("nhóm OC2 chỉ gửi ảnh thành phẩm, không gửi chữ, typing, cảm xúc hoặc báo lỗi", async () => {
  const sent: string[] = [];
  let fail = false;
  const channel = new ZaloPersonalChannel({
    id: "zp-oc2-only-photo", name: "OC2", token: "{}",
    config: { auto_edit_photo_group: "group:oc2", auto_reaction: "heart" },
    requirePairing: false,
    onInbound: async (message, hooks) => {
      hooks?.onStatus?.("thinking");
      hooks?.onBlockReply?.("Tin trả lời sớm");
      if (fail) throw new Error("OpenAI unavailable");
      return { kind: "reply", text: "Không được gửi chữ", media: message.media?.length ? ["/tmp/edited.jpg"] : undefined };
    },
  });
  const internals = channel as unknown as Record<string, unknown>;
  internals.api = {
    sendMessage: async (message: { msg: string }) => { sent.push(message.msg); return { message: { msgId: "sent" } }; },
    sendTypingEvent: async () => { sent.push("typing"); },
  };
  internals.account = { id: "me", name: "Shop" };
  internals.isThreadEnabled = () => true;
  internals.collectMedia = async (_content: unknown, msgType: string) =>
    msgType === "chat.photo" ? [{ kind: "photo", dataUrl: "data:image/png;base64,iVBORw0KGgo=" }] : [];
  internals.sendFiles = async () => { sent.push("photo"); };
  const handle = (channel as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage.bind(channel);
  const message = (msgId: string, msgType: string, content: unknown) => ({
    type: ThreadType.Group, threadId: "oc2", isSelf: false,
    data: { msgId, cliMsgId: `cli-${msgId}`, uidFrom: "member", dName: "Thành viên", content, msgType, ts: String(Date.now()) },
  });
  await handle(message("oc2-text", "chat.text", "@Trợ lý đang làm gì?"));
  expect(sent).toEqual([]);
  sent.length = 0;
  await handle(message("oc2-photo", "chat.photo", { title: "Chỉnh ảnh này" }));
  expect(sent).toEqual(["photo"]);
  sent.length = 0;
  fail = true;
  await handle(message("oc2-failed", "chat.photo", { title: "Chỉnh tiếp" }));
  expect(sent).toEqual([]);
});

it("câu hỏi giá trích dẫn ảnh đã gửi vẫn tới Agent và được trả lời", async () => {
  const sent: string[] = [];
  let inbound: { text: string; quoted?: { msgId: string; kind: string } } | undefined;
  const channel = new ZaloPersonalChannel({
    id: "zp-quoted-question", name: "Zalo", token: "{}", config: {}, requirePairing: false,
    onInbound: async (message) => {
      inbound = message;
      return { kind: "reply", text: "Chậu 8 cành giá 1.600.000đ." };
    },
  });
  const internals = channel as unknown as Record<string, unknown>;
  internals.api = { sendMessage: async (message: { msg: string }) => {
    sent.push(message.msg); return { message: { msgId: "sent" } };
  } };
  internals.account = { id: "me", name: "Shop" };
  internals.isThreadEnabled = () => true;
  const handle = (channel as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage.bind(channel);
  await handle({
    type: ThreadType.User, threadId: "customer", isSelf: false,
    data: { msgId: "question-1", cliMsgId: "cli-1", uidFrom: "customer", dName: "Khách",
      content: "Mẫu này, 8 cành bao nhiêu", msgType: "chat.text", ts: String(Date.now()),
      quote: { globalMsgId: 8367577646050, cliMsgType: 32 } },
  });
  expect(inbound?.text).toBe("Mẫu này, 8 cành bao nhiêu");
  expect(inbound?.quoted).toEqual({ msgId: "8367577646050", kind: "photo" });
  expect(sent).toEqual(["Chậu 8 cành giá 1.600.000đ."]);
});

it("thu hồi tin từ chính tài khoản Zalo báo đúng hội thoại và mã tin cho server, không gọi agent", async () => {
  const undone: Array<{ threadId: string; peerKind: string; targetMsgId: string }> = [];
  let inbound = 0;
  const channel = new ZaloPersonalChannel({
    id: "zp-undo", name: "Zalo", token: "{}", config: {}, requirePairing: false,
    onInbound: async () => { inbound++; return { kind: "ignore" }; },
    onMessageUndo: async (event) => { undone.push(event); return true; },
  });
  const handleUndo = (channel as unknown as { handleUndo: (undo: unknown) => Promise<void> }).handleUndo.bind(channel);
  await handleUndo({ isSelf: true, isGroup: false, threadId: "customer", data: { content: { globalMsgId: 8364497023559 } } });
  await handleUndo({ isSelf: false, isGroup: false, threadId: "customer", data: { content: { globalMsgId: 8364495701458 } } });
  expect(undone).toEqual([{ threadId: "customer", peerKind: "direct", targetMsgId: "8364497023559" }]);
  expect(inbound).toBe(0);
});

describe("Reaction: tự thả cảm xúc + thả tay", () => {
  afterEach(() => vi.useRealTimers());

  function setup(config: Record<string, unknown>) {
    const logs: ChannelMessageLog[] = [];
    const reactions: ChannelReaction[] = [];
    const calls: Array<{ icon: unknown; dest: { data: { msgId: string; cliMsgId: string }; threadId: string; type: unknown } }> = [];
    const channel = new ZaloPersonalChannel({
      id: "zp-rx",
      name: "Zalo rx",
      token: "{}",
      config,
      requirePairing: true,
      onInbound: async () => ({ kind: "ignore" }),
      onMessageLog: (e) => logs.push(e),
      onReaction: (r) => reactions.push(r),
    });
    const c = channel as unknown as Record<string, unknown>;
    c.api = { addReaction: async (icon: unknown, dest: never) => (calls.push({ icon, dest }), { msgIds: [1] }) };
    c.account = { id: "me-1", name: "Shop" };
    const handle = (channel as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage.bind(channel);
    const inbound = (threadId: string, msgId: string, group = false) =>
      handle({
        type: group ? 1 : 0,
        threadId,
        isSelf: false,
        data: { msgId, cliMsgId: "c" + msgId, uidFrom: "u-7", dName: "Khách", content: "alo", msgType: "webchat", ts: String(Date.now()) },
      });
    return { channel, logs, reactions, calls, inbound };
  }

  it("parseAutoReaction: chỉ heart/like, còn lại = tắt", () => {
    expect(parseAutoReaction({})).toBeNull();
    expect(parseAutoReaction({ auto_reaction: "heart" })).toBe("heart");
    expect(parseAutoReaction({ auto_reaction: "like" })).toBe("like");
    expect(parseAutoReaction({ auto_reaction: "off" })).toBeNull();
    expect(ZALO_REACTIONS.heart).toBe("/-heart");
    expect(ZALO_REACTIONS.none).toBe("");
  });

  it("bản dội lại của tin PenAI gửi → báo cliMsgId để bổ sung (thả cảm xúc được)", async () => {
    const ids: Array<[string, string]> = [];
    const channel = new ZaloPersonalChannel({
      id: "zp-cli", name: "x", token: "{}", config: {}, requirePairing: true,
      onInbound: async () => ({ kind: "ignore" }),
      onMessageLog: () => {},
      onMessageCliId: (m, c) => ids.push([m, c]),
    });
    const c = channel as unknown as Record<string, unknown>;
    c.api = { sendMessage: async () => ({ message: { msgId: 777 }, attachment: [] }) };
    c.account = { id: "me-1", name: "Shop" };
    await channel.sendManual({ threadId: "g-1", peerKind: "group", text: "hi", source: "mcp" });
    const handle = (channel as unknown as { handleMessage: (m: unknown) => Promise<void> }).handleMessage.bind(channel);
    await handle({ type: 1, threadId: "g-1", isSelf: true, data: { msgId: "777", cliMsgId: "c777", uidFrom: "0", content: "hi", msgType: "webchat", ts: "1" } });
    expect(ids).toEqual([["777", "c777"]]);
  });

  it("tin khách lưu kèm cliMsgId (để thả cảm xúc về sau)", async () => {
    const { logs, inbound } = setup({});
    await inbound("u-7", "m1");
    expect(logs[0]?.meta).toMatchObject({ cliMsgId: "cm1" });
  });

  it("mặc định TẮT: không tự thả", async () => {
    vi.useFakeTimers();
    const { calls, inbound } = setup({});
    await inbound("u-7", "m1");
    await vi.advanceTimersByTimeAsync(6000);
    expect(calls).toHaveLength(0);
  });

  it("bật ❤️: khách nhắn dồn → chỉ thả tin cuối; nhóm cũng thả; báo onReaction nguồn auto", async () => {
    vi.useFakeTimers();
    const { calls, reactions, inbound } = setup({ auto_reaction: "heart" });
    await inbound("u-7", "m1");
    await vi.advanceTimersByTimeAsync(500);
    await inbound("u-7", "m2");
    await inbound("g-1", "m3", true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.map((c) => c.dest.data.msgId).sort()).toEqual(["m2", "m3"]);
    expect(calls.every((c) => c.icon === "/-heart")).toBe(true);
    expect(calls.find((c) => c.dest.data.msgId === "m3")?.dest.type).toBe(1);
    expect(reactions.map((r) => [r.targetMsgId, r.source, r.reactorId])).toContainEqual(["m2", "auto", "me-1"]);
  });

  it("tắt nóng: hẹn giờ đang chờ bị hủy", async () => {
    vi.useFakeTimers();
    const { channel, calls, inbound } = setup({ auto_reaction: "like" });
    await inbound("u-7", "m1");
    channel.setAutoReaction(null);
    await vi.advanceTimersByTimeAsync(6000);
    expect(calls).toHaveLength(0);
  });

  it("thả tay (web) + gỡ; thiếu cliMsgId thì báo lỗi rõ", async () => {
    const { channel, calls, reactions } = setup({});
    await channel.react({ threadId: "u-7", peerKind: "direct", msgId: "m9", cliMsgId: "c9", reaction: "wow", source: "web", webUserId: "user-1" });
    expect(calls[0]).toMatchObject({ icon: ":o", dest: { data: { msgId: "m9", cliMsgId: "c9" }, threadId: "u-7", type: 0 } });
    expect(reactions[0]).toMatchObject({ source: "web", webUserId: "user-1", icon: ":o" });
    await channel.react({ threadId: "u-7", peerKind: "direct", msgId: "m9", cliMsgId: "c9", reaction: "none", source: "web" });
    expect(calls[1]?.icon).toBe("");
    await expect(
      channel.react({ threadId: "u-7", peerKind: "direct", msgId: "m9", cliMsgId: "", reaction: "heart", source: "web" }),
    ).rejects.toThrow(/thiếu mã/);
  }, 10_000);
});
