import { describe, expect, it } from "vitest";
import type { InboxMessageRow } from "@penai/db";
import { expectsCurrentColorPhotos, latestDelegableStaffMessage, promisedPotStemCount } from "../src/orchid-staff-delegation.js";

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
    expect(latestDelegableStaffMessage([
      row("out", "app", "A gui e mau chau 8 canh nha"),
      row("out", "app", "/ld"), row("out", "app", "-ld"),
    ])).toBe("A gui e mau chau 8 canh nha");
    expect(latestDelegableStaffMessage([
      row("out", "app", "A gui e mau chau 8 canh nha"),
      row("in", "zalo", "không cần"), row("out", "app", "-ld"),
    ])).toBeNull();
  });

  it("requires real photos for a promise to send available colors", () => {
    expect(expectsCurrentColorPhotos("a gửi màu đang có e lựa nha")).toBe(true);
    expect(expectsCurrentColorPhotos("Anh gửi màu hiện có cho em chọn nhé")).toBe(true);
    expect(expectsCurrentColorPhotos("Để anh kiểm tra phí ship")).toBe(false);
  });

  it("recognizes the employee's 8-stem pot promise without accents", () => {
    expect(promisedPotStemCount("A gui e mau chau 8 canh nha")).toBe(8);
    expect(promisedPotStemCount("Anh gửi em mẫu chậu 8 cành nha")).toBe(8);
    expect(promisedPotStemCount("Chậu 8 cành giá sao?")).toBeNull();
  });
});
