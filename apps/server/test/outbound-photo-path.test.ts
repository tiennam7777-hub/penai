import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { prepareZaloPhotoPaths } from "../src/outbound-photo-path.js";

it("gives extensionless JPEG a photo path without renaming the original", async () => {
  const root = await mkdtemp(join(tmpdir(), "penai-zalo-photo-"));
  try {
    const source = join(root, "20-cay-a33-chau-trung");
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
    await writeFile(source, jpeg);
    const text = join(root, "ghi-chu");
    await writeFile(text, "ghi chu");
    const [photo, unchanged, alreadyNamed] = await prepareZaloPhotoPaths([source, text, join(root, "ok.jpg")], join(root, "user"));
    expect(photo).toMatch(/20-cay-a33-chau-trung-[0-9a-f]{8}\.jpg$/);
    expect(await readFile(photo!)).toEqual(jpeg);
    expect(await readFile(source)).toEqual(jpeg);
    expect(unchanged).toBe(text);
    expect(alreadyNamed).toBe(join(root, "ok.jpg"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
