import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { editOrchidPhotoWithOpenAI, type OrchidPhotoEditor } from "./orchid-photo-openai.js";

const TARGET_NAME = "hinh-hoa-dang-co-42dbp";
const MAX_PENDING = 20;
const pendingLocks = new Map<string, Promise<void>>();

export function isAuthorizedDirectPhotoSender(input: {
  channelKind: string;
  peerKind: string;
  senderId: string;
  chatKey: string;
  configuredSender: unknown;
}): boolean {
  return input.channelKind === "zalo_personal" && input.peerKind === "direct" &&
    typeof input.configuredSender === "string" && input.configuredSender.length > 0 &&
    input.configuredSender === input.senderId && input.chatKey === `direct:${input.senderId}`;
}

/** Serialize photos and -sa from one Zalo sender, since Zalo dispatches messages concurrently. */
export async function withDirectPhotoLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prior = pendingLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const tail = prior.then(() => next);
  pendingLocks.set(key, tail);
  await prior;
  try {
    return await task();
  } finally {
    release();
    if (pendingLocks.get(key) === tail) pendingLocks.delete(key);
  }
}

export function directPhotoPendingDir(userDir: string): string {
  return join(userDir, ".photo-edit-pending");
}

export async function pendingPhotoCount(pendingDir: string): Promise<number> {
  return (await readdir(pendingDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })).filter((entry) => entry.isFile()).length;
}

export function canQueuePhotos(current: number, incoming: number): boolean {
  return incoming > 0 && current + incoming <= MAX_PENDING;
}

/** Edit every queued image before touching the live shared folder. Keep the prior folder as a backup. */
export async function publishDirectPhotoBatch(input: {
  pendingDir: string;
  workspaceDir: string;
  agentPrompt: string;
  editor: OrchidPhotoEditor;
  carrierModel: string;
}): Promise<{ count: number; files: string[]; backupDir: string }> {
  const names = (await readdir(input.pendingDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })).filter((entry) => entry.isFile()).map((entry) => entry.name);
  if (!names.length) throw new Error("Chưa có ảnh nào được gửi trước lệnh -sa");
  if (names.length > MAX_PENDING) throw new Error(`Chỉ xử lý tối đa ${MAX_PENDING} ảnh mỗi lượt`);
  const ordered = await Promise.all(names.map(async (name) => ({
    name,
    mtime: (await stat(join(input.pendingDir, name))).mtimeMs,
  })));
  ordered.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));

  const sharedDir = join(input.workspaceDir, "shared");
  const targetDir = join(sharedDir, TARGET_NAME);
  const nonce = randomBytes(8).toString("hex");
  const stageDir = join(sharedDir, `.${TARGET_NAME}-stage-${nonce}`);
  const backupDir = join(input.workspaceDir, "photo-edit-backups", `${TARGET_NAME}-${new Date().toISOString().replace(/[:.]/g, "-")}-${nonce}`);
  await mkdir(stageDir, { recursive: false });
  let oldMoved = false;
  try {
    for (let i = 0; i < ordered.length; i++) {
      const source = join(input.pendingDir, ordered[i]!.name);
      const edited = await editOrchidPhotoWithOpenAI(
        await readFile(source), input.agentPrompt, input.editor, input.carrierModel, "moderate",
      );
      await writeFile(join(stageDir, `anh-${String(i + 1).padStart(2, "0")}.jpg`), edited.data);
    }
    await mkdir(join(input.workspaceDir, "photo-edit-backups"), { recursive: true });
    await rename(targetDir, backupDir);
    oldMoved = true;
    try {
      await rename(stageDir, targetDir);
    } catch (error) {
      await rename(backupDir, targetDir);
      oldMoved = false;
      throw error;
    }
    await rm(input.pendingDir, { recursive: true, force: true }).catch(() => {});
    return {
      count: ordered.length,
      files: ordered.map((_, i) => join(targetDir, `anh-${String(i + 1).padStart(2, "0")}.jpg`)),
      backupDir,
    };
  } catch (error) {
    if (!oldMoved) await rm(stageDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
