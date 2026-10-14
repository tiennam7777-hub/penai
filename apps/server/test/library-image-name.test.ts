import { describe, expect, it } from "vitest";
import { libraryImageName } from "../src/library-image-name.js";

describe("library image names", () => {
  it("adds the JPEG suffix only to an extensionless JPEG", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    expect(libraryImageName("20-cay-a33-chau-beo", jpeg)).toBe("20-cay-a33-chau-beo.jpg");
    expect(libraryImageName("20-cay-a33-chau-beo.jpg", jpeg)).toBe("20-cay-a33-chau-beo.jpg");
    expect(libraryImageName("ghi-chu", jpeg)).toBe("ghi-chu.jpg");
    expect(libraryImageName("ghi-chu", Buffer.from("plain text"))).toBe("ghi-chu");
  });

  it("keeps the right extension for PNG and WebP", () => {
    expect(libraryImageName("hoa", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe("hoa.png");
    expect(libraryImageName("hoa", Buffer.from("RIFF1234WEBP", "ascii"))).toBe("hoa.webp");
  });
});
