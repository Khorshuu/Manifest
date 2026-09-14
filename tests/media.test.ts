/**
 * Product media.
 *
 * The rules with teeth: only staff may add product photography, the file's own
 * bytes decide what it is rather than what the browser claims, and the stored
 * filename is generated so a supplied name cannot escape the directory.
 */
import { eq } from "drizzle-orm";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { productImages, users } from "@/db/schema";
import { AuthorizationError } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import {
  addProductImage,
  createCategory,
  createProduct,
  listProductImages,
  makeProductImagePrimary,
  MediaError,
  removeProductImage,
  reorderProductImage,
  replaceProductImage,
} from "@/lib/catalog";
import {
  LocalMediaProvider,
  setMediaProviderForTesting,
  sniffImageType,
  UploadRejectedError,
  validateUpload,
} from "@/lib/providers/media";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;
let uploadDir = "";

const staff: SessionUser = {
  id: "",
  email: "staff@example.com",
  role: "staff_admin",
};
const customer: SessionUser = {
  id: "",
  email: "shopper@example.com",
  role: "customer",
};

/** A minimal but genuine PNG: the signature plus a byte of payload. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(64, 1),
]);

beforeAll(async () => {
  harness = await createTestDatabase();
  uploadDir = await mkdtemp(join(tmpdir(), "media-test-"));
  setMediaProviderForTesting(new LocalMediaProvider(uploadDir, "/uploads"));
}, 60_000);

afterAll(async () => {
  setMediaProviderForTesting(undefined);
  await rm(uploadDir, { recursive: true, force: true });
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();

  const rows = await harness.db
    .insert(users)
    .values([
      { email: "staff@example.com", passwordHash: "x", role: "staff_admin" },
      { email: "shopper@example.com", passwordHash: "x", role: "customer" },
    ])
    .returning({ id: users.id, email: users.email });

  staff.id = rows.find((r) => r.email === "staff@example.com")!.id;
  customer.id = rows.find((r) => r.email === "shopper@example.com")!.id;
});

async function seedProduct() {
  const suffix = Math.random().toString(36).slice(2, 8);
  const category = await createCategory(staff, {
    name: `Cat ${suffix}`,
    slug: `cat-${suffix}`,
  });
  return createProduct(staff, {
    title: `Product ${suffix}`,
    categoryId: category.id,
  });
}

describe("sniffing the format", () => {
  it("recognises a PNG by its signature", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
  });

  it("recognises a JPEG by its signature", () => {
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
  });

  it("recognises WebP", () => {
    const webp = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.alloc(4),
      Buffer.from("WEBP"),
      Buffer.alloc(32),
    ]);
    expect(sniffImageType(webp)).toBe("image/webp");
  });

  it("returns nothing for something that is not an image", () => {
    expect(sniffImageType(Buffer.from("#!/bin/sh\nrm -rf /\n"))).toBeNull();
  });

  it("returns nothing for a file too short to identify", () => {
    expect(sniffImageType(Buffer.from([0xff]))).toBeNull();
  });
});

describe("validating an upload", () => {
  /**
   * The important one: a browser content type is a claim. An executable
   * renamed to .jpg arrives labelled image/jpeg.
   */
  it("refuses a script that claims to be an image", () => {
    expect(() =>
      validateUpload({
        data: Buffer.from("#!/bin/sh\necho pwned\n"),
        originalName: "photo.jpg",
        contentType: "image/jpeg",
      }),
    ).toThrow(UploadRejectedError);
  });

  it("refuses a file whose bytes contradict its declared type", () => {
    expect(() =>
      validateUpload({
        data: PNG,
        originalName: "photo.jpg",
        contentType: "image/jpeg",
      }),
    ).toThrow(/do not match/);
  });

  it("refuses an empty file", () => {
    expect(() =>
      validateUpload({
        data: Buffer.alloc(0),
        originalName: "empty.png",
        contentType: "image/png",
      }),
    ).toThrow(/empty/);
  });

  it("refuses a file above the size limit", () => {
    const huge = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]);
    expect(() =>
      validateUpload({
        data: huge,
        originalName: "huge.png",
        contentType: "image/png",
      }),
    ).toThrow(/under/);
  });

  it("accepts a real image and reports what it actually is", () => {
    expect(
      validateUpload({
        data: PNG,
        originalName: "photo.png",
        contentType: "image/png",
      }),
    ).toBe("image/png");
  });
});

describe("storing a file", () => {
  it("generates the filename rather than trusting the browser", async () => {
    const provider = new LocalMediaProvider(uploadDir, "/uploads");

    const stored = await provider.upload({
      data: PNG,
      // A name carrying traversal and a second extension.
      originalName: "../../etc/passwd.php.png",
      contentType: "image/png",
    });

    expect(stored.key).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(stored.key).not.toContain("passwd");
    expect(stored.url).toBe(`/uploads/${stored.key}`);

    const written = await readdir(uploadDir);
    expect(written).toContain(stored.key);
  });

  it("refuses to delete through a key containing a path", async () => {
    const provider = new LocalMediaProvider(uploadDir, "/uploads");
    await expect(provider.delete("../../etc/passwd")).rejects.toThrow(
      /not valid/,
    );
  });
});

describe("attaching media to a product", () => {
  it("refuses a customer", async () => {
    const product = await seedProduct();

    await expect(
      addProductImage(customer, product.id, {
        data: PNG,
        originalName: "photo.png",
        contentType: "image/png",
        altText: "A product",
      }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("refuses an anonymous caller", async () => {
    const product = await seedProduct();

    await expect(
      addProductImage(null, product.id, {
        data: PNG,
        originalName: "photo.png",
        contentType: "image/png",
        altText: "A product",
      }),
    ).rejects.toThrow();
  });

  /** An image without alternative text is unusable with a screen reader. */
  it("requires alternative text", async () => {
    const product = await seedProduct();

    await expect(
      addProductImage(staff, product.id, {
        data: PNG,
        originalName: "photo.png",
        contentType: "image/png",
        altText: "   ",
      }),
    ).rejects.toThrow(MediaError);
  });

  it("attaches the image and records it", async () => {
    const product = await seedProduct();

    const created = await addProductImage(staff, product.id, {
      data: PNG,
      originalName: "photo.png",
      contentType: "image/png",
      altText: "Candy box in its retail packaging",
    });

    expect(created.altText).toBe("Candy box in its retail packaging");

    const images = await listProductImages(product.id);
    expect(images).toHaveLength(1);
  });

  it("appends each new image after the existing ones", async () => {
    const product = await seedProduct();

    const first = await addProductImage(staff, product.id, {
      data: PNG,
      originalName: "one.png",
      contentType: "image/png",
      altText: "First",
    });
    const second = await addProductImage(staff, product.id, {
      data: JPEG,
      originalName: "two.jpg",
      contentType: "image/jpeg",
      altText: "Second",
    });

    expect(first.sortOrder).toBe(0);
    expect(second.sortOrder).toBe(1);
  });

  it("reorders the gallery", async () => {
    const product = await seedProduct();

    await addProductImage(staff, product.id, {
      data: PNG,
      originalName: "one.png",
      contentType: "image/png",
      altText: "First",
    });
    const second = await addProductImage(staff, product.id, {
      data: JPEG,
      originalName: "two.jpg",
      contentType: "image/jpeg",
      altText: "Second",
    });

    await reorderProductImage(staff, second.id, "up");

    const images = await listProductImages(product.id);
    expect(images[0].altText).toBe("Second");
  });

  it("removes the row and the file together", async () => {
    const product = await seedProduct();

    const created = await addProductImage(staff, product.id, {
      data: PNG,
      originalName: "photo.png",
      contentType: "image/png",
      altText: "A product",
    });

    const key = created.url.split("/").pop()!;
    expect(await readdir(uploadDir)).toContain(key);

    await removeProductImage(staff, created.id);

    const rows = await harness.db
      .select()
      .from(productImages)
      .where(eq(productImages.id, created.id));

    expect(rows).toHaveLength(0);
    expect(await readdir(uploadDir)).not.toContain(key);
  });

  it("refuses a customer removing an image", async () => {
    const product = await seedProduct();
    const created = await addProductImage(staff, product.id, {
      data: PNG,
      originalName: "photo.png",
      contentType: "image/png",
      altText: "A product",
    });

    await expect(removeProductImage(customer, created.id)).rejects.toThrow(
      AuthorizationError,
    );
  });
});

describe("choosing the main photograph", () => {
  const add = async (productId: string, altText: string) =>
    addProductImage(staff, productId, {
      data: PNG,
      originalName: "photo.png",
      contentType: "image/png",
      altText,
    });

  it("moves one image to the front and keeps the rest in order", async () => {
    const product = await seedProduct();
    await add(product.id, "First");
    await add(product.id, "Second");
    const third = await add(product.id, "Third");

    await makeProductImagePrimary(staff, third.id);

    const order = (await listProductImages(product.id)).map((row) => row.altText);
    expect(order).toEqual(["Third", "First", "Second"]);
  });

  it("refuses a customer", async () => {
    const product = await seedProduct();
    const image = await add(product.id, "First");

    await expect(makeProductImagePrimary(customer, image.id)).rejects.toThrow(
      AuthorizationError,
    );
  });
});

/** Replace and Edit in the crop editor (D-049). */
describe("replacing a photograph", () => {
  it("swaps the file in place, keeping its position and description", async () => {
    const product = await seedProduct();
    const first = await addProductImage(staff, product.id, {
      data: PNG,
      originalName: "one.png",
      contentType: "image/png",
      altText: "First",
    });
    const second = await addProductImage(staff, product.id, {
      data: PNG,
      originalName: "two.png",
      contentType: "image/png",
      altText: "Second",
    });

    const replaced = await replaceProductImage(staff, product.id, second.id, {
      data: JPEG,
      originalName: "two-cropped.jpg",
      contentType: "image/jpeg",
      altText: "  ",
    });

    expect(replaced.id).toBe(second.id);
    expect(replaced.sortOrder).toBe(1);
    expect(replaced.altText).toBe("Second");
    expect(replaced.url).not.toBe(second.url);
    expect(replaced.url).toMatch(/\.jpg$/);

    const images = await listProductImages(product.id);
    expect(images.map((image) => image.id)).toEqual([first.id, second.id]);
  });

  it("takes a new description when one is given", async () => {
    const product = await seedProduct();
    const image = await addProductImage(staff, product.id, {
      data: PNG,
      originalName: "one.png",
      contentType: "image/png",
      altText: "Old words",
    });

    const replaced = await replaceProductImage(staff, product.id, image.id, {
      data: PNG,
      originalName: "one.png",
      contentType: "image/png",
      altText: "New words",
    });

    expect(replaced.altText).toBe("New words");
  });

  /** Past orders may still show the earlier address. */
  it("leaves the previous file in storage", async () => {
    const product = await seedProduct();
    const image = await addProductImage(staff, product.id, {
      data: PNG,
      originalName: "one.png",
      contentType: "image/png",
      altText: "Kept",
    });
    const before = (await readdir(uploadDir)).length;

    await replaceProductImage(staff, product.id, image.id, {
      data: JPEG,
      originalName: "one.jpg",
      contentType: "image/jpeg",
    });

    const files = await readdir(uploadDir);
    expect(files.length).toBe(before + 1);
    expect(files).toContain(image.url.split("/").pop());
  });

  it("refuses an image that belongs to another product", async () => {
    const product = await seedProduct();
    const other = await seedProduct();
    const image = await addProductImage(staff, other.id, {
      data: PNG,
      originalName: "one.png",
      contentType: "image/png",
      altText: "Elsewhere",
    });

    await expect(
      replaceProductImage(staff, product.id, image.id, {
        data: PNG,
        originalName: "one.png",
        contentType: "image/png",
      }),
    ).rejects.toThrow(MediaError);
  });

  it("refuses a customer", async () => {
    const product = await seedProduct();
    const image = await addProductImage(staff, product.id, {
      data: PNG,
      originalName: "one.png",
      contentType: "image/png",
      altText: "Mine",
    });

    await expect(
      replaceProductImage(customer, product.id, image.id, {
        data: PNG,
        originalName: "one.png",
        contentType: "image/png",
      }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("refuses a file that is not an image", async () => {
    const product = await seedProduct();
    const image = await addProductImage(staff, product.id, {
      data: PNG,
      originalName: "one.png",
      contentType: "image/png",
      altText: "Mine",
    });

    await expect(
      replaceProductImage(staff, product.id, image.id, {
        data: Buffer.from("#!/bin/sh\necho pwned\n"),
        originalName: "one.png",
        contentType: "image/png",
      }),
    ).rejects.toThrow();
  });
});
