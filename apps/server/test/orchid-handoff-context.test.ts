import { describe, expect, it } from "vitest";
import type { InboxMessageRow } from "@penai/db";
import { orchidHandoffContext } from "../src/orchid-handoff-context.js";

function message(direction: "in" | "out", source: InboxMessageRow["source"], text: string): InboxMessageRow {
  return { direction, source, text, senderName: "Lan", contentType: "text" } as InboxMessageRow;
}

describe("orchid handoff context", () => {
  it("shows the recent customer and staff exchange with distinct speakers", () => {
    const result = orchidHandoffContext([
      message("in", "peer", "Chậu này 8 cành giá bao nhiêu?"),
      message("out", "web", "Anh sẽ kiểm tra giá rồi báo em"),
      message("out", "agent", "Giá tạm tính 1,6 triệu"),
      message("in", "peer", "Mai giao được không?"),
    ]);
    expect(result).toContain("Khách (Lan): Chậu này 8 cành giá bao nhiêu?");
    expect(result).toContain("Nhân viên: Anh sẽ kiểm tra giá rồi báo em");
    expect(result).toContain("AI: Giá tạm tính 1,6 triệu");
    expect(result).toContain("Chỉ đáp yêu cầu mới nhất");
  });

  it("bounds long history and leaves empty threads untouched", () => {
    expect(orchidHandoffContext([])).toBe("");
    const result = orchidHandoffContext(Array.from({ length: 80 }, (_, i) =>
      message("in", "peer", `Tin ${i}: ${"x".repeat(900)}`)));
    expect(result).not.toContain("Tin 0:");
    expect(result).toContain("Tin 79:");
    expect(result.length).toBeLessThan(8_300);
  });
});
