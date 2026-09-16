/**
 * The server image pipeline (lib/images/normalize.ts, D-055): what is stored
 * is always a freshly encoded sRGB WebP of bounded size, with the orientation
 * baked in and no metadata left, and anything that cannot be decoded safely is
 * refused.
 */
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { MAX_STORED_EDGE, normalizeImage } from "@/lib/images/normalize";
import { UploadRejectedError } from "@/lib/providers/media";

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 30, g: 90, b: 160 } } });

describe("normalising an upload", () => {
  it("re-encodes to WebP and reports the stored size and hash", async () => {
    const result = await normalizeImage(await solid(300, 200).jpeg().toBuffer());
    expect(result.contentType).toBe("image/webp");
    expect(result.data.toString("ascii", 8, 12)).toBe("WEBP");
    expect(result).toMatchObject({ width: 300, height: 200 });
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("drops EXIF, including a GPS position", async () => {
    const withExif = await solid(64, 64)
      .jpeg()
      .withExif({ IFD0: { Make: "Camera Co", Copyright: "Someone" }, IFD3: { GPSLatitudeRef: "N" } })
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const stored = await sharp((await normalizeImage(withExif)).data).metadata();
    expect(stored.exif).toBeUndefined();
    expect(stored.xmp).toBeUndefined();
    expect(stored.icc).toBeUndefined();
  });

  it("bakes the EXIF orientation into the pixels", async () => {
    // 60 wide by 20 tall, marked "rotate 90°": a viewer shows it 20 by 60.
    const sideways = await solid(60, 20).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const result = await normalizeImage(sideways);
    expect(result).toMatchObject({ width: 20, height: 60 });
    expect((await sharp(result.data).metadata()).orientation).toBeUndefined();
  });

  it("converts a CMYK photograph to sRGB", async () => {
    const cmyk = await solid(32, 32).toColourspace("cmyk").jpeg().toBuffer();
    expect((await sharp(cmyk).metadata()).space).toBe("cmyk");
    expect((await sharp((await normalizeImage(cmyk)).data).metadata()).space).toBe("srgb");
  });

  it("shrinks anything larger than the site shows, and never enlarges", async () => {
    const large = await normalizeImage(await solid(4000, 3000).png().toBuffer());
    expect(Math.max(large.width, large.height)).toBe(MAX_STORED_EDGE);
    expect(large.width / large.height).toBeCloseTo(4 / 3, 2);

    const small = await normalizeImage(await solid(120, 80).png().toBuffer());
    expect(small).toMatchObject({ width: 120, height: 80 });
  });

  /** A tiny file that decodes to a vast bitmap. */
  it("refuses an image with too many pixels before decoding it", async () => {
    // A real PNG whose header claims 20,000 × 20,000 (400MP), with a valid CRC.
    const bomb = Buffer.from(await solid(64, 64).png().toBuffer());
    bomb.writeUInt32BE(20_000, 16);
    bomb.writeUInt32BE(20_000, 20);
    bomb.writeUInt32BE(crc32(bomb.subarray(12, 29)), 29);
    expect((await sharp(bomb, { limitInputPixels: false }).metadata()).width).toBe(20_000);
    await expect(normalizeImage(bomb)).rejects.toThrow(/too many pixels/);
  });

  it("refuses a file with an image signature but corrupt contents", async () => {
    const good = await solid(64, 64).png().toBuffer();
    const truncated = good.subarray(0, Math.floor(good.length / 2));
    await expect(normalizeImage(truncated)).rejects.toThrow(UploadRejectedError);

    const signatureOnly = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
    await expect(normalizeImage(signatureOnly)).rejects.toThrow(UploadRejectedError);
  });

  it("does not carry bytes appended after the image", async () => {
    const payload = Buffer.from("<script>alert(1)</script>");
    const polyglot = Buffer.concat([await solid(64, 64).png().toBuffer(), payload]);
    const result = await normalizeImage(polyglot);
    expect(result.data.includes(payload)).toBe(false);
  });

  it("keeps transparency", async () => {
    const clear = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toBuffer();
    expect((await sharp((await normalizeImage(clear)).data).metadata()).hasAlpha).toBe(true);
  });
});
