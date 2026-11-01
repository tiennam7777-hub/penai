import { describe, expect, it } from "vitest";
import type { Db } from "@penai/db";
import type { WorkspaceContext } from "@penai/shared";
import { allowedInboxChannelIds } from "../src/inbox.js";

const moderator: WorkspaceContext = {
  workspaceId: "b2978901-abc3-4919-b636-d599f986f3c2",
  userId: "00000000-0000-4000-8000-000000000001",
  role: "moderator",
};

describe("moderator Inbox channel scope", () => {
  it("shows all Inbox channels to moderator while MCP keeps its own grants", async () => {
    const channels = [
      { id: "hot-1", kind: "zalo_personal" },
      { id: "hot-6", kind: "zalo_personal" },
      { id: "page-1", kind: "facebook_page" },
      { id: "other", kind: "telegram" },
    ];
    const tx = {
      execute: async () => ({ rows: [{ channel_id: "hot-6" }] }),
      select: () => ({ from: async () => channels }),
    };
    const db = { transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as Db;
    expect(await allowedInboxChannelIds(db, moderator)).toEqual(["hot-1", "hot-6", "page-1"]);
    expect(await allowedInboxChannelIds(db, moderator, "mcp")).toEqual(["hot-6"]);
    expect(await allowedInboxChannelIds(db, { ...moderator, role: "member" })).toEqual(["hot-6"]);
    expect(await allowedInboxChannelIds(db, { ...moderator, role: "operator" })).toEqual(["hot-1", "hot-6", "page-1"]);
    expect(await allowedInboxChannelIds(db, { ...moderator, role: "ws_admin" })).toEqual(["hot-1", "hot-6", "page-1"]);
  });
});
