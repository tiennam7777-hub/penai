import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Keep the sent image under the workspace so Inbox can serve it after Zalo confirms delivery. */
export async function withKiotVietSlipImage<T>(
  data: Record<string, unknown>,
  storage: { dataDir: string; workspaceId: string; channelId: string },
  send: (path: string) => Promise<T>,
): Promise<T> {
  const month = new Date().toISOString().slice(0, 7);
  const dir = resolve(join(storage.dataDir, storage.workspaceId, "zalo-inbox", storage.channelId, month));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `phieu-dat-hang-${randomUUID()}.png`);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = execFile("python3", [fileURLToPath(new URL("./kiotviet-slip-image.py", import.meta.url)), path],
        { timeout: 15_000 }, (error) => error ? reject(error) : resolve());
      child.stdin?.end(JSON.stringify(data));
    });
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
  // A Zalo send can be partially successful before throwing; retain the file for any logged photo.
  return send(path);
}
