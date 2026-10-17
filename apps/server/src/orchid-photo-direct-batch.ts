import { readdir } from "node:fs/promises";
import { join } from "node:path";
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

/** Serialize photos and commands from one Zalo sender, since Zalo dispatches messages concurrently. */
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
