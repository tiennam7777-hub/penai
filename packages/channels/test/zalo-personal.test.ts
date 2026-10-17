import { describe, expect, it, vi } from "vitest";
import type { Message } from "zca-js";
import {
  chunkZaloText,
  loadZaloContactAliases,
  normalizeZaloChatKey,
  parseZaloDemoThreads,
  parseZaloAttachmentParams,
  parseZaloPersonalCredentials,
  shouldHandleZaloGroup,
  trustedZaloMediaUrl,
  zaloMediaKind,
  ZaloPersonalChannel,
} from "../src/zalo-personal.js";
import { supportedChannelKinds } from "../src/manager.js";

describe("Zalo photo download", () => {
  it("keeps an Inbox copy of an incoming photo before its CDN link expires", async () => {
    const onMessageLog = vi.fn();
    const saveInboxFile = vi.fn(async () => "/saved/inbox-photo.jpg");
    const channel = new ZaloPersonalChannel({
      id: "zp-inbox-photo", name: "Zalo", token: "{}", config: {}, requirePairing: true,
      onInbound: async () => ({ kind: "ignore" }), onMessageLog, saveInboxFile,
    });
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { status: 200, headers: { "content-type": "image/jpeg" } })));
    try {
      await (channel as unknown as { logListenerMessage: (message: Message, peerKind: "direct", threadId: string, senderId: string, senderName: string) => Promise<void> })
        .logListenerMessage({ isSelf: false, data: { msgId: "photo-1", msgType: "chat.photo", content: { href: "https://photo-stal-1.zdn.vn/gr/jpg/example.jpg" } } } as Message,
          "direct", "customer-1", "customer-1", "Chị Mai");
      expect(saveInboxFile).toHaveBeenCalledWith(bytes, "jpg");
      expect(onMessageLog).toHaveBeenCalledWith(expect.objectContaining({ contentType: "photo", media: expect.objectContaining({ localPath: "/saved/inbox-photo.jpg" }) }));
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("retries an empty CDN response before handing the image to OC2", async () => {
    const channel = new ZaloPersonalChannel({
      id: "zp-photo", name: "Zalo", token: "{}", config: {}, requirePairing: true,
      onInbound: async () => ({ kind: "ignore" }),
    });
    const photo = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(new Uint8Array(), { status: 200 }))
      .mockResolvedValueOnce(new Response(photo, { status: 200, headers: { "content-type": "image/jpeg" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const media = await (channel as unknown as {
        collectMedia: (content: unknown, msgType: string) => Promise<Array<{ kind: string; dataUrl?: string }>>;
      }).collectMedia({ href: "https://photo-stal-1.zdn.vn/gr/jpg/example.jpg" }, "chat.photo");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(media).toEqual([{ kind: "photo", name: "anh-zalo", dataUrl: `data:image/jpeg;base64,${photo.toString("base64")}` }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Zalo contact aliases", () => {
  it("syncs an alias for a non-friend without turning the person into a friend", async () => {
    const channel = new ZaloPersonalChannel({
      id: "zp-alias", name: "Zalo alias", token: "{}", config: {}, requirePairing: true,
      onInbound: async () => ({ kind: "ignore" }),
    });
    (channel as unknown as { api: unknown }).api = {
      getAllFriends: async () => [{ userId: "friend", zaloName: "Friend" }],
      getAliasList: async () => ({ updateTime: "0", items: [
        { userId: "friend", alias: "Friend alias" },
        { userId: "customer", alias: "Chi Trinh Ghé Mua 0903759396" },
      ] }),
      getAllGroups: async () => ({ gridVerMap: {} }),
    };
    const targets = await channel.listTargets();
    expect(targets).toContainEqual(expect.objectContaining({
      id: "customer", name: "", contactAlias: "Chi Trinh Ghé Mua 0903759396", isContact: false,
    }));
    expect(targets).toContainEqual(expect.objectContaining({
      id: "friend", name: "Friend", contactAlias: "Friend alias",
    }));
  });

  it("reads every page, including aliases missing from displayName", async () => {
    const pages: number[] = [];
    const result = await loadZaloContactAliases({ getAliasList: async (_count, page) => {
      pages.push(page!);
      return { updateTime: "0", items: page === 1
        ? Array.from({ length: 100 }, (_, i) => ({ userId: String(i), alias: `Contact ${i}` }))
        : [{ userId: "100", alias: "Quỳnh Thuỷ - IM GROUP" }] };
    } });
    expect(pages).toEqual([1, 2]);
    expect(result.size).toBe(101);
    expect(result.get("100")).toBe("Quỳnh Thuỷ - IM GROUP");
  });

  it("rejects partial results rather than clearing aliases from unread pages", async () => {
    await expect(loadZaloContactAliases({ getAliasList: async (_count, page) => {
      if (page === 2) throw new Error("Zalo unavailable");
      return { updateTime: "0", items: Array.from({ length: 100 }, (_, i) => ({ userId: String(i), alias: "Saved" })) };
    } })).rejects.toThrow("Zalo unavailable");
  });
});

describe("Zalo Inbox message removal", () => {
  it("uses platform undo for everyone and delete only for this account", async () => {
    const calls: unknown[][] = [];
    const channel = new ZaloPersonalChannel({
      id: "zp-remove", name: "Zalo", token: "{}", config: {}, requirePairing: true,
      onInbound: async () => ({ kind: "ignore" }),
    });
    (channel as unknown as { api: unknown; account: unknown }).api = {
      undo: async (...args: unknown[]) => { calls.push(["undo", ...args]); return { status: 0 }; },
      deleteMessage: async (...args: unknown[]) => { calls.push(["delete", ...args]); return { status: 0 }; },
    };
    (channel as unknown as { account: unknown }).account = { id: "owner-1", name: "Owner" };
    await channel.changeMessageState({
      threadId: "peer-1", peerKind: "direct", msgId: "g-1", cliMsgId: "c-1", action: "recalled",
    });
    await channel.changeMessageState({
      threadId: "group-1", peerKind: "group", msgId: "g-2", cliMsgId: "c-2", action: "deleted",
    });
    expect(calls[0]).toEqual(["undo", { msgId: "g-1", cliMsgId: "c-1" }, "peer-1", expect.anything()]);
    expect(calls[1]).toEqual(["delete", {
      data: { msgId: "g-2", cliMsgId: "c-2", uidFrom: "owner-1" },
      threadId: "group-1", type: expect.anything(),
    }, true]);
    await expect(channel.changeMessageState({
      threadId: "peer-1", peerKind: "direct", msgId: "", cliMsgId: "", action: "recalled",
    })).rejects.toThrow("thiếu mã");
  });

  it("passes a customer's recall event to Inbox instead of ignoring it", async () => {
    const events: unknown[] = [];
    const channel = new ZaloPersonalChannel({
      id: "zp-undo", name: "Zalo", token: "{}", config: {}, requirePairing: true,
      onInbound: async () => ({ kind: "ignore" }),
      onMessageUndo: async (event) => { events.push(event); return false; },
    });
    await (channel as unknown as { handleUndo: (event: unknown) => Promise<void> }).handleUndo({
      isSelf: false, isGroup: true, threadId: "group-1", data: { content: { globalMsgId: "g-3" } },
    });
    expect(events).toEqual([{ threadId: "group-1", peerKind: "group", targetMsgId: "g-3", isSelf: false }]);
  });
});

function groupData(patch: Record<string, unknown> = {}): Message["data"] {
  return {
    actionId: "1",
    msgId: "m1",
    cliMsgId: "c1",
    msgType: "webchat",
    uidFrom: "user-1",
    idTo: "group-1",
    dName: "Người dùng",
    ts: "1",
    status: 1,
    content: "xin chào",
    notify: "",
    ttl: 0,
    userId: "user-1",
    uin: "",
    topOut: "",
    topOutTimeOut: "",
    topOutImprTimeOut: "",
    propertyExt: undefined,
    paramsExt: { countUnread: 0, containType: 0, platformType: 0 },
    cmd: 0,
    st: 0,
    at: 0,
    realMsgId: "m1",
    quote: undefined,
    ...patch,
  } as Message["data"];
}

describe("Zalo Personal registration", () => {
  it("đăng ký kind riêng, không ghi đè Zalo OA", () => {
    const kinds = supportedChannelKinds();
    expect(kinds).toContain("zalo");
    expect(kinds).toContain("zalo_personal");
  });

  it("khởi động được ở trạng thái chờ QR khi chưa có credential", async () => {
    const channel = new ZaloPersonalChannel({
      id: "zp-1",
      name: "Zalo test",
      token: "{}",
      config: {},
      requirePairing: true,
      onInbound: async () => ({ kind: "ignore" }),
    });
    await channel.start();
    expect(channel.status()).toMatchObject({ running: true, connected: false });
    await channel.stop();
    expect(channel.isRunning()).toBe(false);
  });
});

describe("Zalo Personal credentials", () => {
  it("chỉ nhận credential restore đầy đủ", () => {
    expect(parseZaloPersonalCredentials("{}")).toBeNull();
    expect(parseZaloPersonalCredentials("not-json")).toBeNull();
    expect(
      parseZaloPersonalCredentials(
        JSON.stringify({ imei: "imei", userAgent: "ua", cookie: [] }),
      ),
    ).toMatchObject({ imei: "imei", userAgent: "ua" });
  });
});

describe("Zalo Personal group gating", () => {
  it("bỏ tin group thường khi bắt buộc mention", () => {
    expect(shouldHandleZaloGroup(groupData(), "bot-1", true)).toBe(false);
  });

  it("nhận @mention đích danh, không coi @all là mention bot", () => {
    expect(
      shouldHandleZaloGroup(
        groupData({ mentions: [{ uid: "bot-1", pos: 0, len: 4, type: 0 }] }),
        "bot-1",
        true,
      ),
    ).toBe(true);
    expect(
      shouldHandleZaloGroup(
        groupData({ mentions: [{ uid: "-1", pos: 0, len: 4, type: 1 }] }),
        "bot-1",
        true,
      ),
    ).toBe(false);
  });

  it("nhận reply vào tin của bot và lệnh slash", () => {
    expect(
      shouldHandleZaloGroup(groupData({ quote: { ownerId: "bot-1" } }), "bot-1", true),
    ).toBe(true);
    expect(shouldHandleZaloGroup(groupData({ content: "/help" }), "bot-1", true)).toBe(true);
  });
});

describe("Zalo Personal safe mode", () => {
  const makeChannel = (config: Record<string, unknown> = {}) =>
    new ZaloPersonalChannel({
      id: "zp-safe",
      name: "Zalo safe",
      token: "{}",
      config,
      requirePairing: false,
      onInbound: async () => ({ kind: "ignore" }),
    });

  it("chuẩn hóa chatKey và đọc demo_threads từ config", () => {
    expect(normalizeZaloChatKey("group:123")).toBe("group:123");
    expect(normalizeZaloChatKey("987")).toBe("direct:987");
    expect(
      parseZaloDemoThreads({ demo_threads: ["group:1", "group:1", 42, "direct:2"] }),
    ).toEqual(["group:1", "direct:2"]);
    expect(parseZaloDemoThreads({})).toEqual([]);
    expect(parseZaloDemoThreads({ demo_threads: "group:1" })).toEqual([]);
  });

  it("mặc định không có thread demo — status báo safe mode, danh sách trống", () => {
    const channel = makeChannel();
    expect(channel.status()).toMatchObject({
      safeMode: true,
      demoThreads: [],
      observedCount: 0,
    });
    expect(channel.listObserved()).toEqual([]);
  });

  it("chặn test message ngoài thread demo, cho thread được chỉ định", async () => {
    const channel = makeChannel({ demo_threads: ["group:g-demo"] });
    await expect(
      channel.sendTestMessage("g-khac", "group", "xin chào"),
    ).rejects.toThrow(/Chế độ an toàn Zalo/);
    // Thread demo hợp lệ: vượt qua gate an toàn, chỉ dừng ở bước chưa đăng nhập
    await expect(
      channel.sendTestMessage("g-demo", "group", "xin chào"),
    ).rejects.toThrow(/chưa đăng nhập/);
  });

  it("send() kiểm tra allowlist trước cả trạng thái đăng nhập (fail-closed)", async () => {
    const channel = makeChannel({ demo_threads: ["group:g-demo"] });
    await expect(
      channel.send({ chatKey: "group:g-khac", text: "hi" }),
    ).rejects.toThrow(/Chế độ an toàn Zalo/);
    await expect(
      channel.send({ chatKey: "group:g-demo", text: "hi" }),
    ).rejects.toThrow(/chưa đăng nhập/);
  });

  it("tắt yêu cầu pairing → DM mở (openDirect), nhóm ngoài demo vẫn chặn", async () => {
    const channel = makeChannel(); // requirePairing: false
    expect(channel.status().openDirect).toBe(true);
    // DM người lạ: vượt gate an toàn, chỉ dừng ở bước chưa đăng nhập
    await expect(
      channel.send({ chatKey: "direct:nguoi-la", text: "hi" }),
    ).rejects.toThrow(/chưa đăng nhập/);
    // Nhóm lạ: vẫn fail-closed — không mở nhóm tự do
    await expect(
      channel.send({ chatKey: "group:nhom-la", text: "hi" }),
    ).rejects.toThrow(/Chế độ an toàn Zalo/);
  });

  it("bật yêu cầu pairing → DM ngoài demo vẫn bị chặn fail-closed", async () => {
    const channel = new ZaloPersonalChannel({
      id: "zp-pair",
      name: "Zalo pairing",
      token: "{}",
      config: {},
      requirePairing: true,
      onInbound: async () => ({ kind: "ignore" }),
    });
    expect(channel.status().openDirect).toBe(false);
    await expect(
      channel.send({ chatKey: "direct:nguoi-la", text: "hi" }),
    ).rejects.toThrow(/Chế độ an toàn Zalo/);
  });

  it("setDemoThreads cập nhật nóng và bỏ entry sai định dạng", () => {
    const channel = makeChannel();
    channel.setDemoThreads(["group:abc", "direct:xyz", "  ", "raw-id"]);
    // "raw-id" được chuẩn hóa thành direct:raw-id; chuỗi rỗng bị loại
    expect(channel.demoThreads()).toEqual(["direct:raw-id", "direct:xyz", "group:abc"]);
  });
});

describe("Zalo Personal output", () => {
  it("bỏ markdown và chia tin không vượt giới hạn", () => {
    const chunks = chunkZaloText(`**Tiêu đề**\n${"nội dung ".repeat(500)}`, 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((part) => part.length <= 200)).toBe(true);
    expect(chunks[0]).toContain("Tiêu đề");
    expect(chunks[0]).not.toContain("**");
  });
});

describe("Zalo Personal inbound media", () => {
  it("tin cậy CDN file/ảnh chat (*.zdn.vn) và avatar (*.zadn.vn), chỉ https", () => {
    expect(trustedZaloMediaUrl("https://f18-zpg.zdn.vn/123/bao-cao.xlsx?x=1")?.hostname).toBe(
      "f18-zpg.zdn.vn",
    );
    expect(trustedZaloMediaUrl("https://f47-photo.talk.zdn.vn/a.jpg")).not.toBeNull();
    expect(trustedZaloMediaUrl("https://s120-ava-talk.zadn.vn/a.jpg")).not.toBeNull();
    expect(trustedZaloMediaUrl("http://f18-zpg.zdn.vn/a.xlsx")).toBeNull();
    expect(trustedZaloMediaUrl("https://evil.example.com/zdn.vn/a.xlsx")).toBeNull();
    expect(trustedZaloMediaUrl("https://zdn.vn.evil.com/a.xlsx")).toBeNull();
    expect(trustedZaloMediaUrl("not a url")).toBeNull();
  });

  it("phân loại theo msgType của Zalo, content.type rỗng vẫn đúng", () => {
    expect(zaloMediaKind("chat.file", "")).toBe("document");
    expect(zaloMediaKind("chat.photo", "")).toBe("photo");
    expect(zaloMediaKind("chat.gif", "")).toBe("photo");
    expect(zaloMediaKind("chat.voice", "")).toBe("voice");
    expect(zaloMediaKind("chat.video.msg", "")).toBe("video");
    expect(zaloMediaKind("chat.sticker", "")).toBe("sticker");
    expect(zaloMediaKind("", "")).toBe("unknown");
    expect(zaloMediaKind("", "photo")).toBe("photo");
  });

  it("đọc fileExt/fileSize từ params JSON, bỏ qua params hỏng", () => {
    expect(parseZaloAttachmentParams('{"fileExt":"xlsx","fileSize":"12345","checksum":"x"}')).toEqual({
      fileExt: "xlsx",
      fileSize: 12345,
    });
    expect(parseZaloAttachmentParams("{oops")).toEqual({});
    expect(parseZaloAttachmentParams(undefined)).toEqual({});
  });
});
