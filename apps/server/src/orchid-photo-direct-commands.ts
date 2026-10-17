import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { editOrchidPhotoWithOpenAI, type OrchidPhotoEditor } from "./orchid-photo-openai.js";

export type PhotoCommand = "-sa" | "-bs";
export function directPhotoCommand(text: string): PhotoCommand | null {
  const value = text.trim().toLowerCase();
  return value === "-sa" || value === "-bs" ? value : null;
}

const TARGET = "hinh-hoa-dang-co-42dbp";
const INDEX = ".photo-sources.json";
const IMAGE = /\.(?:jpe?g|png|webp)$/i;
type IndexedPhoto = { name: string; originalSha: string };
type Queued = { bytes: Buffer; record: IndexedPhoto; path: string };

function digest(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
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
    return { bytes, path, record: { name: "", originalSha: digest(bytes) } };
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
