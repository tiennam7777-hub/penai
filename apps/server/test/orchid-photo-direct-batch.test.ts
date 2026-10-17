import { describe, expect, it } from "vitest";
import { isAuthorizedDirectPhotoSender, withDirectPhotoLock } from "../src/orchid-photo-direct-batch.js";

describe("Hot 4 photo command routing", () => {
  it("accepts only the configured Hot 4 UID in its own direct chat", () => {
    const input = { channelKind: "zalo_personal", peerKind: "direct", senderId: "hot4", chatKey: "direct:hot4", configuredSender: "hot4" };
    expect(isAuthorizedDirectPhotoSender(input)).toBe(true);
    expect(isAuthorizedDirectPhotoSender({ ...input, senderId: "other" })).toBe(false);
    expect(isAuthorizedDirectPhotoSender({ ...input, peerKind: "group" })).toBe(false);
    expect(isAuthorizedDirectPhotoSender({ ...input, configuredSender: undefined })).toBe(false);
  });

  it("serializes photos and commands from the same sender", async () => {
    const order: number[] = [];
    await Promise.all([
      withDirectPhotoLock("hot4", async () => { order.push(1); await new Promise((resolve) => setTimeout(resolve, 10)); order.push(2); }),
      withDirectPhotoLock("hot4", async () => { order.push(3); }),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });
});
