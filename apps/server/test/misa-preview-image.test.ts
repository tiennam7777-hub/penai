import { describe, expect, it } from "vitest";
import { renderMisaPreviewPages } from "../src/misa-preview-image.js";

function samplePdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length 39 >>\nstream\nBT /F1 24 Tf 30 100 Td (Draft) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

describe("MISA draft preview images", () => {
  it("renders a complete PDF page to a PNG photo", async () => {
    const pages = await renderMisaPreviewPages(samplePdf());
    expect(pages).toHaveLength(1);
    expect(pages[0]!.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("rejects a non-PDF response", async () => {
    await expect(renderMisaPreviewPages(Buffer.from("<html>error</html>"))).rejects.toThrow("PDF");
  });
});
