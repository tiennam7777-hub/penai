import { describe, expect, it } from "vitest";
import type { InboxMessageRow } from "@penai/db";
import type { Provider } from "@penai/providers";
import {
  classifyOrchidFlowerComplaint, formatOrchidFlowerComplaintDispatch,
  mayConcernOrchidFlowerComplaint, orchidFlowerComplaintFingerprint,
  parseOrchidFlowerComplaintAction,
} from "../src/orchid-flower-complaint.js";

const row = (text: string, direction: "in" | "out" = "in"): InboxMessageRow => ({
  id: "1", threadId: "123", msgId: "z1", direction, source: direction === "in" ? "zalo" : "agent",
  senderId: "sender", senderName: "Khách", webUserId: null, webUserName: null,
  contentType: "text", text, media: null, meta: null, sentAt: "2026-10-16T08:00:00.000Z",
});

describe("orchid flower complaint dispatch", () => {
  it("detects flower damage and a followup about staff responsibility", () => {
    expect(mayConcernOrchidFlowerComplaint("Mà 4 bông nhăn cánh rồi", [])).toBe(true);
    expect(mayConcernOrchidFlowerComplaint("Cây này e thấy k ổn lắm", [])).toBe(true);
    expect(mayConcernOrchidFlowerComplaint("Bên anh tự lựa và đóng thùng mà", [row("Cây này bị gập")])).toBe(true);
    expect(mayConcernOrchidFlowerComplaint("Giá chậu 5 cành bao nhiêu?", [])).toBe(false);
  });

  it("accepts only known classification actions", () => {
    expect(parseOrchidFlowerComplaintAction('{"action":"retail_report"}')).toBe("retail_report");
    expect(parseOrchidFlowerComplaintAction('{"action":"wholesale_escalation"}')).toBe("wholesale_escalation");
    expect(parseOrchidFlowerComplaintAction('{"action":"none"}')).toBeNull();
    expect(parseOrchidFlowerComplaintAction("oops")).toBeNull();
  });

  it("deduplicates the same Zalo complaint without hiding later incidents", () => {
    expect(formatOrchidFlowerComplaintDispatch("Chị Mai\nKhách sỉ"))
      .toBe("Chị Mai Khách sỉ báo hoa có vấn đề, cần xử lý.");
    const now = new Date("2026-10-16T17:30:00Z");
    expect(orchidFlowerComplaintFingerprint("zalo-1", "Hoa héo", now))
      .toBe(orchidFlowerComplaintFingerprint("zalo-1", "Hoa héo", now));
    expect(orchidFlowerComplaintFingerprint("zalo-2", "Hoa héo", now))
      .not.toBe(orchidFlowerComplaintFingerprint("zalo-1", "Hoa héo", now));
  });

  it("does not send wholesale reports for an initial complaint or accept a mismatched class", async () => {
    const provider = { chat: async () => ({
      stopReason: "end", toolCalls: [], content: '{"action":"retail_report"}',
    }) } as unknown as Provider;
    expect(await classifyOrchidFlowerComplaint(provider, "test", [row("Cây bị gập")],
      { text: "Cây bị gập", senderName: "Khách" }, "wholesale", new Date("2026-10-16T08:00:00Z")))
      .toBeNull();
    expect(await classifyOrchidFlowerComplaint(provider, "test", [row("Cây bị gập")],
      { text: "Cây bị gập", senderName: "Khách" }, "retail", new Date("2026-10-16T08:00:00Z")))
      .toBe("retail_report");
  });
});
