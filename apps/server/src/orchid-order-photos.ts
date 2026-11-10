import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { InboxMessageRow } from "@penai/db";
import { confineMediaPath } from "@penai/tools";
import { stemCountForPhoto } from "./orchid-photo-count.js";
import type { OrchidOrderPhotoEvidence } from "./orchid-order-dispatch.js";

/** Only local photos belonging to the current customer's scoped Inbox history. */
export async function loadOrchidOrderPhotos(
  messages: InboxMessageRow[], workspaceDir: string,
): Promise<OrchidOrderPhotoEvidence[]> {
  const photos: OrchidOrderPhotoEvidence[] = [];
  const rows = messages.filter((m) => m.contentType === "photo" && !m.meta?.removed).slice(-3);
  for (const row of rows) {
    const rawPath = row.media?.localPath;
    if (typeof rawPath !== "string") continue;
    try {
      const path = await confineMediaPath(rawPath, [workspaceDir]);
      if (!path) continue;
      const ext = extname(path).toLowerCase();
      const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp"
        : [".jpg", ".jpeg"].includes(ext) ? "image/jpeg" : null;
      if (!mime || (await stat(path)).size > 10 * 1024 * 1024) continue;
      const bytes = await readFile(path);
      if (!bytes.length || bytes.length > 10 * 1024 * 1024) continue;
      const stored = row.media?.stemCount;
      const stems = typeof stored === "number" && Number.isInteger(stored) && stored >= 1 && stored <= 99
        ? stored : await stemCountForPhoto(join(workspaceDir, "shared"), path);
      photos.push({ messageId: row.msgId || row.id, sentAt: row.sentAt,
        dataUrl: `data:${mime};base64,${bytes.toString("base64")}`, stems });
    } catch { /* Missing/unsupported photo must fall back to staff review, never drop the order. */ }
  }
  return photos;
}
