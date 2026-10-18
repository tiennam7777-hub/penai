import { PDFParse } from "pdf-parse";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Render every page of MISA's unpublished preview as a Zalo photo. */
export async function renderMisaPreviewPages(pdf: Buffer): Promise<Buffer[]> {
  if (pdf.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("Bản xem trước MISA không phải PDF hợp lệ");
  }
  const parser = new PDFParse({ data: new Uint8Array(pdf) });
  try {
    const result = await parser.getScreenshot({ desiredWidth: 1500, imageDataUrl: false, imageBuffer: true });
    if (!result.pages.length || result.pages.length > 10 || result.pages.length !== result.total) {
      throw new Error("Bản xem trước MISA có số trang bất thường; chưa gửi ảnh cho khách");
    }
    return result.pages.map((page) => {
      const bytes = Buffer.from(page.data);
      if (bytes.length < 100 || bytes.length > 10 * 1024 * 1024 ||
          bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
        throw new Error("Không tạo được ảnh PNG hóa đơn nháp hợp lệ");
      }
      return bytes;
    });
  } finally {
    await parser.destroy();
  }
}

export async function saveMisaPreviewImages(pdf: Buffer, dir: string, refId: string): Promise<string[]> {
  if (!/^[0-9a-f-]{36}$/i.test(refId)) throw new Error("Mã hóa đơn nháp MISA không hợp lệ");
  const pages = await renderMisaPreviewPages(pdf);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const paths: string[] = [];
  for (const [index, page] of pages.entries()) {
    const path = join(dir, `${refId}-trang-${index + 1}.png`);
    await writeFile(path, page, { mode: 0o600 });
    paths.push(path);
  }
  return paths;
}
