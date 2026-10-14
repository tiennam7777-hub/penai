import { extname } from "node:path";

/** Give extensionless images a real extension before they enter the library. */
export function libraryImageName(name: string, header: Uint8Array): string {
  if (extname(name)) return name;
  const bytes = Buffer.from(header);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return `${name}.jpg`;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return `${name}.png`;
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return `${name}.webp`;
  return name;
}
