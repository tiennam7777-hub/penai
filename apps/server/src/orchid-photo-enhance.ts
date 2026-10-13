import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 10 * 1024 * 1024;
const SCRIPT = fileURLToPath(new URL("./orchid-photo-enhance.py", import.meta.url));

/** Chỉnh trực tiếp ảnh gốc bằng Pillow; không gọi model sinh ảnh. */
export async function enhanceOrchidPhoto(input: Buffer): Promise<Buffer> {
  if (!input.length || input.length > MAX_BYTES) throw new Error("Ảnh phải nhỏ hơn 10 MB");
  return new Promise((resolve, reject) => {
    const python = process.env.PENAI_PHOTO_PYTHON || (process.platform === "win32" ? "python" : "python3");
    const child = spawn(python, [SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BYTES) child.kill();
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-500); });
    child.stdin.on("error", () => {});
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) return reject(new Error("Hết thời gian chỉnh ảnh"));
      if (size > MAX_BYTES) return reject(new Error("Ảnh sau chỉnh vượt giới hạn gửi Zalo 10 MB"));
      if (code !== 0 || !size) return reject(new Error(stderr || "Không chỉnh được ảnh"));
      resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}
