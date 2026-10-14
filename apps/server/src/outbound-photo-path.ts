import { copyFile, mkdir, open } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { randomBytes } from "node:crypto";

/** Keep old extensionless source images untouched while giving Zalo a photo filename. */
export async function prepareZaloPhotoPaths(paths: string[], userDir: string): Promise<string[]> {
  const result: string[] = [];
  for (const path of paths) {
    if (extname(path)) { result.push(path); continue; }
    const file = await open(path, "r");
    const header = Buffer.alloc(12);
    try { await file.read(header, 0, header.length, 0); }
    finally { await file.close(); }
    const ext = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff ? ".jpg"
      : header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? ".png"
      : header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP" ? ".webp"
      : "";
    if (!ext) { result.push(path); continue; }
    await mkdir(userDir, { recursive: true });
    const copy = join(userDir, `${basename(path)}-${randomBytes(4).toString("hex")}${ext}`);
    await copyFile(path, copy);
    result.push(copy);
  }
  return result;
}
