import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { photoDifferenceHash } from "./orchid-photo-count.js";
import { editOrchidPhotoWithOpenAI, type OrchidPhotoEditor } from "./orchid-photo-openai.js";

export type PhotoCommand = "-sa" | "-bs" | "-het";
export function directPhotoCommand(text: string): PhotoCommand | null {
  const value = text.trim().toLowerCase();
  return value === "-sa" || value === "-bs" || value === "-het" ? value : null;
}

const TARGET = "hinh-hoa-dang-co-42dbp";
const INDEX = ".photo-sources.json";
const IMAGE = /\.(?:jpe?g|png|webp)$/i;
type IndexedPhoto = { name: string; originalSha: string; originalHash?: string };
type Queued = { bytes: Buffer; record: IndexedPhoto; path: string };

function digest(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
async function hash(value: Buffer): Promise<string | undefined> {
  try { return (await photoDifferenceHash(value)).toString(16).padStart(16, "0"); }
  catch { return undefined; }
}
function distance(a: string, b: string): number {
  let bits = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (bits) { bits &= bits - 1n; count++; }
  return count;
}
async function photosIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const rows = await Promise.all(entries.filter((e) => e.isFile() && IMAGE.test(e.name)).map(async (e) => ({
    name: e.name, mtime: (await stat(join(dir, e.name))).mtimeMs,
  })));
  return rows.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name)).map((e) => e.name);
}
async function readIndex(dir: string): Promise<IndexedPhoto[]> {
  try {
    const value: unknown = JSON.parse(await readFile(join(dir, INDEX), "utf8"));
    return Array.isArray(value) ? value.filter((v): v is IndexedPhoto =>
      !!v && typeof v.name === "string" && typeof v.originalSha === "string" && IMAGE.test(v.name)) : [];
  } catch { return []; }
}
async function writeIndex(dir: string, rows: IndexedPhoto[]): Promise<void> {
  const temporary = join(dir, `.photo-sources-${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(temporary, JSON.stringify(rows));
  await rename(temporary, join(dir, INDEX));
}
function backupDir(workspaceDir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(workspaceDir, "photo-edit-backups", `${TARGET}-${stamp}-${randomBytes(6).toString("hex")}`);
}
async function queued(pendingDir: string): Promise<Queued[]> {
  return Promise.all((await photosIn(pendingDir)).map(async (name) => {
    const path = join(pendingDir, name);
    const bytes = await readFile(path);
    const originalHash = await hash(bytes);
    return { bytes, path, record: { name: "", originalSha: digest(bytes), ...(originalHash ? { originalHash } : {}) } };
  }));
}

/** The raw photos become live before any image model call. Edit failures leave raw photos live. */
export async function addDirectPhotos(input: {
  command: "-sa" | "-bs"; pendingDir: string; workspaceDir: string;
  agentPrompt: string; editor: OrchidPhotoEditor; carrierModel: string;
  onPublished?: (count: number) => Promise<void>;
}): Promise<{ count: number; edited: number; files: string[]; backupDir?: string }> {
  const all = await queued(input.pendingDir);
  if (!all.length) throw new Error(`Chưa có ảnh nào được gửi trước lệnh ${input.command}`);
  const target = join(input.workspaceDir, "shared", TARGET);
  const existing = input.command === "-bs" ? await readIndex(target) : [];
  const seen = new Set(existing.map((row) => row.originalSha));
  const photos = all.filter((p) => {
    if (seen.has(p.record.originalSha)) return false;
    seen.add(p.record.originalSha); return true;
  });
  if (!photos.length) throw new Error("Các ảnh này đã có trong bộ màu hiện tại");
  let backup: string | undefined;
  if (input.command === "-sa") {
    const stage = join(input.workspaceDir, "shared", `.${TARGET}-stage-${randomBytes(8).toString("hex")}`);
    await mkdir(stage);
    try {
      for (let i = 0; i < photos.length; i++) {
        const photo = photos[i]!;
        photo.record.name = `anh-${String(i + 1).padStart(2, "0")}${extname(photo.path).toLowerCase()}`;
        await writeFile(join(stage, photo.record.name), photo.bytes);
      }
      await writeIndex(stage, photos.map((p) => p.record));
      backup = backupDir(input.workspaceDir);
      await mkdir(join(input.workspaceDir, "photo-edit-backups"), { recursive: true });
      await rename(target, backup);
      try { await rename(stage, target); }
      catch (error) { await rename(backup, target); throw error; }
    } catch (error) { await rm(stage, { recursive: true, force: true }).catch(() => {}); throw error; }
  } else {
    await mkdir(target, { recursive: true });
    const added: string[] = [];
    try {
      for (let i = 0; i < photos.length; i++) {
        const photo = photos[i]!;
        photo.record.name = `anh-bs-${randomBytes(8).toString("hex")}-${i + 1}${extname(photo.path).toLowerCase()}`;
        await writeFile(join(target, photo.record.name), photo.bytes);
        added.push(photo.record.name);
      }
      await writeIndex(target, [...existing, ...photos.map((p) => p.record)]);
    } catch (error) {
      await Promise.all(added.map((name) => rm(join(target, name), { force: true })));
      throw error;
    }
  }
  await rm(input.pendingDir, { recursive: true, force: true }).catch(() => {});
  await input.onPublished?.(photos.length).catch(() => {});
  const index = input.command === "-sa" ? photos.map((p) => p.record) : [...existing, ...photos.map((p) => p.record)];
  let edited = 0;
  const files: string[] = [];
  for (const photo of photos) {
    const original = join(target, photo.record.name);
    try {
      const result = await editOrchidPhotoWithOpenAI(photo.bytes, input.agentPrompt, input.editor, input.carrierModel, "moderate");
      const output = original.replace(IMAGE, ".jpg");
      const temporary = join(target, `.edit-${randomBytes(8).toString("hex")}.jpg`);
      await writeFile(temporary, result.data);
      await rename(temporary, output);
      if (output !== original) await rm(original, { force: true });
      photo.record.name = output.slice(target.length + 1);
      await writeIndex(target, index);
      edited++;
      files.push(output);
    } catch { files.push(original); }
  }
  return { count: photos.length, edited, files, ...(backup ? { backupDir: backup } : {}) };
}

/** Match by exact bytes/source first, then by a uniquely close perceptual hash. */
export async function removeDirectPhotos(input: { pendingDir: string; workspaceDir: string }): Promise<{ count: number; backupDir: string }> {
  const incoming = await queued(input.pendingDir);
  if (!incoming.length) throw new Error("Chưa có ảnh nào được gửi trước lệnh -het");
  const target = join(input.workspaceDir, "shared", TARGET);
  const index = await readIndex(target);
  const live = await Promise.all((await photosIn(target)).map(async (name) => {
    const bytes = await readFile(join(target, name));
    return { name, sha: digest(bytes), imageHash: await hash(bytes), source: index.find((row) => row.name === name) };
  }));
  const chosen = new Set<string>();
  for (const photo of incoming) {
    const exact = live.filter((row) => !chosen.has(row.name) &&
      (row.sha === photo.record.originalSha || row.source?.originalSha === photo.record.originalSha));
    if (exact.length > 1) throw new Error("Có nhiều ảnh giống nhau; chưa xóa để tránh nhầm");
    if (exact.length === 1) { chosen.add(exact[0]!.name); continue; }
    if (!photo.record.originalHash) throw new Error("Không nhận diện được ảnh cần xóa");
    const ranked = live.filter((row) => !chosen.has(row.name)).map((row) => ({
      name: row.name,
      score: Math.min(row.source?.originalHash ? distance(photo.record.originalHash!, row.source.originalHash) : 65,
        row.imageHash ? distance(photo.record.originalHash!, row.imageHash) : 65),
    })).sort((a, b) => a.score - b.score);
    if (!ranked[0] || ranked[0].score > 5 || (ranked[1] && ranked[1].score - ranked[0].score < 4)) {
      throw new Error("Chưa nhận diện chắc chắn ảnh trong thư mục; chưa xóa ảnh nào");
    }
    chosen.add(ranked[0].name);
  }
  const backup = backupDir(input.workspaceDir);
  await mkdir(backup, { recursive: true });
  const moved: string[] = [];
  try {
    for (const name of chosen) { await rename(join(target, name), join(backup, name)); moved.push(name); }
    // Older batches may contain compatibility symlinks to the photo being removed.
    for (const entry of await readdir(target, { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) continue;
      const destination = resolve(target, await readlink(join(target, entry.name)));
      if (!destination.startsWith(`${target}${sep}`) || !chosen.has(destination.slice(target.length + 1))) continue;
      await rename(join(target, entry.name), join(backup, entry.name));
      moved.push(entry.name);
    }
    await writeIndex(target, index.filter((row) => !chosen.has(row.name)));
  } catch (error) {
    for (const name of moved) await rename(join(backup, name), join(target, name));
    throw error;
  }
  await rm(input.pendingDir, { recursive: true, force: true }).catch(() => {});
  return { count: chosen.size, backupDir: backup };
}
