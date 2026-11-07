import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadType, type API, type Message } from "zca-js";
import { ZaloPersonalChannel } from "../src/zalo-personal.js";

afterEach(() => vi.unstubAllGlobals());

function message(id: string, threadId: string, photo = false): Message {
  return { type: ThreadType.Group, threadId, isSelf: true, data: {
    msgId: id, uidFrom: "staff", dName: "Staff", ts: String(1_790_000_000_000 + Number(id)),
    msgType: photo ? "chat.photo" : "webchat", content: photo
      ? { href: "https://f47-photo.talk.zdn.vn/old.jpg", title: "old.jpg" } : "-sa",
  } } as unknown as Message;
}

it("archives only configured groups, downloads old photos, skips duplicates and never invokes live handlers", async () => {
  const onHistory = vi.fn(), onMessageLog = vi.fn(), onInbound = vi.fn();
  const saveInboxFile = vi.fn().mockResolvedValue("/archive/old.jpg");
  const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from([1, 2, 3]), {
    status: 200, headers: { "content-type": "image/jpeg" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  const channel = new ZaloPersonalChannel({ id: "history", name: "history", token: "{}",
    config: { inbox_history_groups: ["123"] }, requirePairing: true,
    onInbound, onMessageLog, onHistory, saveInboxFile,
    hasHistoryMessage: async (_thread, id) => id === "20",
  });
  const listener = new EventEmitter() as EventEmitter & { requestOldMessages: ReturnType<typeof vi.fn> };
  const pages = [[message("30", "123", true), message("20", "123", true), message("10", "999")], [message("5", "123")], []];
  listener.requestOldMessages = vi.fn();
  const sendWs = vi.fn(() => queueMicrotask(() => listener.emit("old_messages", pages.shift(), ThreadType.Group)));
  Object.assign(listener, { sendWs });
  const api = { listener } as unknown as API;
  const internal = channel as unknown as { api: API; importGroupHistory(api: API): Promise<void> };
  internal.api = api;
  await internal.importGroupHistory(api);
  expect(sendWs.mock.calls).toHaveLength(3);
  expect(sendWs).toHaveBeenNthCalledWith(2, expect.objectContaining({ data: { first: false, lastId: "10", preIds: [] } }));
  expect(onHistory).toHaveBeenCalledTimes(2);
  expect(onHistory.mock.calls[0]![0][0]).toMatchObject({ threadId: "123", msgId: "30", media: { localPath: "/archive/old.jpg" } });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(onMessageLog).not.toHaveBeenCalled();
  expect(onInbound).not.toHaveBeenCalled();
  expect(listener.listenerCount("old_messages")).toBe(0);
});

it("does not request history without an explicit group selection", async () => {
  const channel = new ZaloPersonalChannel({ id: "disabled", name: "disabled", token: "{}", config: {},
    requirePairing: true, onInbound: vi.fn(), onHistory: vi.fn() });
  const listener = { requestOldMessages: vi.fn() };
  const api = { listener } as unknown as API;
  const internal = channel as unknown as { api: API; importGroupHistory(api: API): Promise<void> };
  internal.api = api;
  await internal.importGroupHistory(api);
  expect(listener.requestOldMessages).not.toHaveBeenCalled();
});

it("stops paging if Zalo repeats its cursor", async () => {
  const channel = new ZaloPersonalChannel({ id: "repeat", name: "repeat", token: "{}",
    config: { inbox_history_groups: ["123"] }, requirePairing: true, onInbound: vi.fn(), onHistory: vi.fn() });
  const listener = new EventEmitter() as EventEmitter & { requestOldMessages: ReturnType<typeof vi.fn> };
  listener.requestOldMessages = vi.fn();
  const sendWs = vi.fn(() => queueMicrotask(() => listener.emit("old_messages", [message("10", "999")], ThreadType.Group)));
  Object.assign(listener, { sendWs });
  const api = { listener } as unknown as API;
  const internal = channel as unknown as { api: API; importGroupHistory(api: API): Promise<void> };
  internal.api = api;
  await internal.importGroupHistory(api);
  expect(sendWs).toHaveBeenCalledTimes(2);
});
