import { describe, expect, it, vi } from "vitest";
import type { Channel } from "@penai/channels";
import { isOrchidOrderSourceKind, orchidOrderNotificationChannel, orchidOrderSourceNotice } from "../src/orchid-order-routing.js";

const source = { id: "fanpage", kind: "facebook_page", workspaceId: "company",
  config: { orchid_order_zalo_channel_id: "hot-1" } };
const zalo = (connected = true, kind = "zalo_personal") => ({
  kind, isConnected: () => connected, sendManual: vi.fn(async () => ["zalo-msg"]),
}) as unknown as Channel;

describe("Fanpage order notifications through Zalo", () => {
  it("uses the explicitly configured Zalo sender instead of sending group IDs to Messenger", async () => {
    const target = zalo();
    const messenger = zalo(true, "facebook_page");
    const channels = new Map([["hot-1", { channel: target, workspaceId: "company" }],
      ["fanpage", { channel: messenger, workspaceId: "company" }]]);
    const runtime = orchidOrderNotificationChannel(source, channels);
    await runtime.sendManual({ threadId: "flower-group", peerKind: "group", source: "agent", text: "Đơn mới" });
    expect(runtime).toBe(target);
    expect((messenger as unknown as { sendManual: ReturnType<typeof vi.fn> }).sendManual).not.toHaveBeenCalled();
  });

  it("preserves Hot 1/4/6's existing sender", () => {
    const target = zalo();
    expect(orchidOrderNotificationChannel({ ...source, id: "hot-4", kind: "zalo_personal", config: {} },
      new Map([["hot-4", { channel: target, workspaceId: "company" }]]))).toBe(target);
  });

  it("does not guess a sender when the Fanpage has no configured route", () => {
    expect(() => orchidOrderNotificationChannel({ ...source, config: {} }, new Map())).toThrow("chưa cấu hình");
  });

  it.each([
    { channel: zalo(), workspaceId: "another-company" },
    { channel: zalo(false), workspaceId: "company" },
    { channel: zalo(true, "facebook_page"), workspaceId: "company" },
  ])("rejects cross-workspace, disconnected, and non-Zalo targets", (entry) => {
    expect(() => orchidOrderNotificationChannel(source, new Map([["hot-1", entry]]))).toThrow("chưa kết nối");
  });

  it("marks both Page sources and the original Messenger conversation in staff notices", () => {
    for (const name of ["Fanpage Orchids World - CN Hòa Bình", "Fanpage Orchids World - Đà Lạt"]) {
      const text = orchidOrderSourceNotice({ kind: "facebook_page", name }, "messenger-customer", "Đơn cần kiểm tra");
      expect(text).toContain(name);
      expect(text).toContain("Messenger; hội thoại: messenger-customer");
    }
    expect(orchidOrderSourceNotice({ kind: "zalo_personal", name: "Hot 1" }, "customer", "Đơn mới")).toBe("Đơn mới");
    expect(isOrchidOrderSourceKind("facebook_page")).toBe(true);
    expect(isOrchidOrderSourceKind("whatsapp_personal")).toBe(false);
  });
});
