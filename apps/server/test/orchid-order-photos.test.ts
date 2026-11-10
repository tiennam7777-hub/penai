import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxMessageRow } from "@penai/db";
vi.mock("../src/orchid-photo-count.js", () => ({ stemCountForPhoto: vi.fn(async () => null) }));
import { stemCountForPhoto } from "../src/orchid-photo-count.js";
import { loadOrchidOrderPhotos } from "../src/orchid-order-photos.js";

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const photo = (path: string, id = "1", extra: Partial<InboxMessageRow> = {}): InboxMessageRow => ({
  id, msgId: `photo-${id}`, contentType: "photo", text: "", threadId: "customer", direction: "in", source: "zalo",
  senderId: "customer", senderName: "Quỳnh Như", webUserId: null, webUserName: null,
  sentAt: "2026-11-08T12:03:52Z", meta: null, media: { localPath: path }, ...extra,
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "order-photo-")); roots.push(root);
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const file = join(workspace, "sample.jpg");
  await writeFile(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  return { root, workspace, file };
}

describe("current order photo evidence", () => {
  it("passes local photo bytes and the stored verified count", async () => {
    const { workspace, file } = await setup();
    const result = await loadOrchidOrderPhotos([photo(file, "8", { media: { localPath: file, stemCount: 8 } })], workspace);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ messageId: "photo-8", stems: 8, dataUrl: "data:image/jpeg;base64,/9j/2Q==" });
    expect(stemCountForPhoto).not.toHaveBeenCalled();
  });

  it("does not infer stems if the submitted photo does not match the library", async () => {
    const { workspace, file } = await setup();
    const result = await loadOrchidOrderPhotos([photo(file)], workspace);
    expect(result[0]!.stems).toBeNull();
    expect(stemCountForPhoto).toHaveBeenCalledWith(join(workspace, "shared"), file);
  });

  it("excludes recalled, missing, unsupported and outside-workspace files", async () => {
    const { root, workspace, file } = await setup();
    const outside = join(root, "other-customer.jpg"); await writeFile(outside, "private");
    const unsupported = join(workspace, "private.txt"); await writeFile(unsupported, "private");
    expect(await loadOrchidOrderPhotos([photo(file, "recalled", { meta: { removed: "recalled" } }),
      photo(outside), photo(unsupported), photo(join(workspace, "missing.jpg"))], workspace)).toEqual([]);
  });

  it("limits provider image input to the three latest active photos", async () => {
    const { workspace, file } = await setup();
    const result = await loadOrchidOrderPhotos(["1", "2", "3", "4"].map((id) => photo(file, id)), workspace);
    expect(result.map((p) => p.messageId)).toEqual(["photo-2", "photo-3", "photo-4"]);
  });
});
