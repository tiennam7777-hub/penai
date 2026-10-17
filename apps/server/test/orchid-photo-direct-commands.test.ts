import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDirectPhotos, directPhotoCommand } from "../src/orchid-photo-direct-commands.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3WQAAAAASUVORK5CYII=", "base64");
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(128)]);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const workspaceDir = await mkdtemp(join(tmpdir(), "penai-photo-commands-"));
  dirs.push(workspaceDir);
  const target = join(workspaceDir, "shared", "hinh-hoa-dang-co-42dbp");
  const pendingDir = join(workspaceDir, "users", "hot4", ".photo-edit-pending");
  await mkdir(target, { recursive: true });
  await mkdir(pendingDir, { recursive: true });
  await writeFile(join(target, "old.jpg"), "old-photo");
  return { workspaceDir, target, pendingDir };
}
function input(f: Awaited<ReturnType<typeof fixture>>, command: "-sa" | "-bs", editor: { generateImage: () => Promise<{ data: Buffer; mime: string }> }, onPublished?: (count: number) => Promise<void>) {
  return { workspaceDir: f.workspaceDir, pendingDir: f.pendingDir, command, agentPrompt: "natural light", carrierModel: "gpt-6-sol", editor, onPublished };
}

describe("Hot 4 photo commands", () => {
  it("recognizes -sa and -bs, but never treats -het as a deletion command", () => {
    expect(directPhotoCommand(" -SA ")).toBe("-sa");
    expect(directPhotoCommand("-bs")).toBe("-bs");
    expect(directPhotoCommand(" -het ")).toBeNull();
    expect(directPhotoCommand("-sa xóa")).toBeNull();
  });

  it("-sa publishes originals and backs up old photos before editing", async () => {
    const f = await fixture();
    await writeFile(join(f.pendingDir, "new.png"), png);
    let liveBeforeEdit = false;
    const result = await addDirectPhotos(input(f, "-sa", {
      async generateImage() {
        const names = await readdir(f.target);
        liveBeforeEdit = names.includes("anh-01.png") && !names.includes("old.jpg");
        return { data: jpeg, mime: "image/jpeg" };
      },
    }));
    expect(liveBeforeEdit).toBe(true);
    expect(result).toMatchObject({ count: 1, edited: 1 });
    expect(await readFile(join(result.backupDir!, "old.jpg"), "utf8")).toBe("old-photo");
    expect(await readdir(f.target)).toContain("anh-01.jpg");
  });

  it("-bs preserves old photos and leaves original live if edit fails", async () => {
    const f = await fixture();
    await writeFile(join(f.pendingDir, "new.png"), png);
    let acknowledged = false;
    const result = await addDirectPhotos(input(f, "-bs", {
      async generateImage() { expect(acknowledged).toBe(true); throw new Error("provider unavailable"); },
    }, async () => { acknowledged = true; }));
    expect(result).toMatchObject({ count: 1, edited: 0 });
    expect(await readdir(f.target)).toContain("old.jpg");
    expect((await readdir(f.target)).some((name) => name.endsWith(".png"))).toBe(true);
  });

});
