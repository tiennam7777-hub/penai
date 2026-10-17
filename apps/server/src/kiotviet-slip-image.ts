import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export async function withKiotVietSlipImage<T>(data: Record<string, unknown>, send: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "penai-kiot-slip-"));
  const path = join(dir, "phieu-dat-hang.png");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = execFile("python3", [fileURLToPath(new URL("./kiotviet-slip-image.py", import.meta.url)), path],
        { timeout: 15_000 }, (error) => error ? reject(error) : resolve());
      child.stdin?.end(JSON.stringify(data));
    });
    return await send(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
