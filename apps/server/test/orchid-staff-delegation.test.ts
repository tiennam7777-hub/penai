import { describe, expect, it } from "vitest";
import type { InboxMessageRow } from "@penai/db";
import { expectsCurrentColorPhotos, latestDelegableStaffMessage } from "../src/orchid-staff-delegation.js";

const row = (direction: "in" | "out", source: InboxMessageRow["source"], text: string) =>
  ({ direction, source, text }) as InboxMessageRow;

describe("Inbox -ld", () => {
  it("uses only the latest staff promise in the same conversation", () => {
    expect(latestDelegableStaffMessage([
      row("in", "zalo", "có màu nào"),
      row("out", "web", "a gửi màu đang có e lựa nha"),
    ])).toBe("a gửi màu đang có e lựa nha");
    expect(latestDelegableStaffMessage([
      row("out", "web", "a gửi màu đang có e lựa nha"),
      row("in", "zalo", "thôi không cần nữa"),
    ])).toBeNull();
    expect(latestDelegableStaffMessage([row("out", "agent", "đã gửi ảnh")])).toBeNull();
    expect(latestDelegableStaffMessage([row("out", "web", "-ld")])).toBeNull();
  });

  it("requires real photos for a promise to send available colors", () => {
    expect(expectsCurrentColorPhotos("a gửi màu đang có e lựa nha")).toBe(true);
    expect(expectsCurrentColorPhotos("Anh gửi màu hiện có cho em chọn nhé")).toBe(true);
    expect(expectsCurrentColorPhotos("Để anh kiểm tra phí ship")).toBe(false);
  });
});
