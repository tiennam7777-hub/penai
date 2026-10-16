import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canQueuePhotos, isAuthorizedDirectPhotoSender, publishDirectPhotoBatch, withDirectPhotoLock } from "../src/orchid-photo-direct-batch.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3WQAAAAASUVORK5CYII=", "base64");
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(128)]);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture(images = 1) {
  const workspaceDir = await mkdtemp(join(tmpdir(), "penai-photo-batch-"));
  dirs.push(workspaceDir);
  const target = join(workspaceDir, "shared", "hinh-hoa-dang-co-42dbp");
  const pendingDir = join(workspaceDir, "users", "hot4", ".photo-edit-pending");
  await mkdir(target, { recursive: true });
  await mkdir(pendingDir, { recursive: true });
  await writeFile(join(target, "old.jpg"), "old");
  for (let i = 0; i < images; i++) await writeFile(join(pendingDir, `${i}.png`), png);
  return { workspaceDir, target, pendingDir };
}

describe("Hot 4 -sa photo batch", () => {
  it("accepts only the configured Hot 4 UID in its own direct chat", () => {
    const input = { channelKind: "zalo_personal", peerKind: "direct", senderId: "hot4", chatKey: "direct:hot4", configuredSender: "hot4" };
    expect(isAuthorizedDirectPhotoSender(input)).toBe(true);
    expect(isAuthorizedDirectPhotoSender({ ...input, senderId: "other" })).toBe(false);
    expect(isAuthorizedDirectPhotoSender({ ...input, peerKind: "group" })).toBe(false);
    expect(isAuthorizedDirectPhotoSender({ ...input, configuredSender: undefined })).toBe(false);
  });

  it("replaces the whole shared folder only after all edits succeed and keeps a backup", async () => {
    const f = await fixture(2);
    const calls: unknown[] = [];
    const result = await publishDirectPhotoBatch({ ...f, agentPrompt: "sáng tự nhiên", carrierModel: "gpt-6-sol",
      editor: { async generateImage(req) { calls.push(req); return { data: jpeg, mime: "image/jpeg" }; } },
    });
    expect(result.count).toBe(2);
    expect((await readdir(f.target)).sort()).toEqual(["anh-01.jpg", "anh-02.jpg"]);
    expect(await readFile(join(result.backupDir, "old.jpg"), "utf8")).toBe("old");
    expect(await readdir(f.pendingDir).catch(() => [])).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ action: "edit", model: "gpt-6-sol", outputFormat: "jpeg" });
  });

  it("leaves old and pending images untouched if any edit fails", async () => {
    const f = await fixture(2);
    let calls = 0;
    await expect(publishDirectPhotoBatch({ ...f, agentPrompt: "sáng tự nhiên", carrierModel: "gpt-6-sol",
      editor: { async generateImage() { if (++calls === 2) throw new Error("model failed"); return { data: jpeg, mime: "image/jpeg" }; } },
    })).rejects.toThrow("model failed");
    expect(await readdir(f.target)).toEqual(["old.jpg"]);
    expect(await readdir(f.pendingDir)).toHaveLength(2);
  });

  it("limits each batch and serializes same-sender requests", async () => {
    expect(canQueuePhotos(19, 1)).toBe(true);
    expect(canQueuePhotos(19, 2)).toBe(false);
    const order: number[] = [];
    await Promise.all([
      withDirectPhotoLock("hot4", async () => { order.push(1); await new Promise((resolve) => setTimeout(resolve, 10)); order.push(2); }),
      withDirectPhotoLock("hot4", async () => { order.push(3); }),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });
});
