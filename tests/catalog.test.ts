/**
 * Catalog behaviour against a real (in-process) Postgres. The role assertions
 * here call the lib/ functions directly, not through a route, because the
 * invariant in docs/SECURITY.md is that a customer cannot succeed by any code
 * path — not merely that no route exposes one.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  attributeValues,
  auditLog,
  productVariants,
  products,
  users,
  variantOptionValues,
} from "@/db/schema";
import { AuthorizationError } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/session";
import {
  addAttributeValue,
  archiveProduct,
  AttributeInUseError,
  buildCategoryTree,
  CategoryInUseError,
  collectSubtreeIds,
  createAttribute,
  createCategory,
  createProduct,
  CycleError,
  deleteAttributeValue,
  deleteCategory,
  findCategoryPath,
  getCategoryTree,
  getProductForAdmin,
  getPublicProductBySlug,
  listProductsForAdmin,
  restoreProduct,
  updateCategory,
  updateProduct,
} from "@/lib/catalog";
import { createTestDatabase } from "./helpers/database";

let harness: Awaited<ReturnType<typeof createTestDatabase>>;

const staff: SessionUser = {
  id: "",
  email: "staff@example.com",
  role: "staff_admin",
};
const customer: SessionUser = {
  id: "",
  email: "customer@example.com",
  role: "customer",
};

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();


  const rows = await harness.db
    .insert(users)
    .values([
      {
        email: "staff@example.com",
        passwordHash: "x",
        role: "staff_admin",
      },
      {
        email: "customer@example.com",
        passwordHash: "x",
        role: "customer",
      },
    ])
    .returning({ id: users.id, role: users.role });

  staff.id = rows.find((r) => r.role === "staff_admin")!.id;
  customer.id = rows.find((r) => r.role === "customer")!.id;
});

async function seedCategory(name = "Audio", slug = "audio") {
  return createCategory(staff, { name, slug });
}

describe("customer restrictions", () => {
  it("refuses a customer creating a category", async () => {
    await expect(
      createCategory(customer, { name: "Sneaky", slug: "sneaky" }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("refuses a customer creating a product", async () => {
    const category = await seedCategory();
    await expect(
      createProduct(customer, {
        title: "Sneaky product",
        categoryId: category.id,
      }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("refuses a customer listing products in the admin view", async () => {
    await expect(listProductsForAdmin(customer)).rejects.toThrow(
      AuthorizationError,
    );
  });

  it("refuses an anonymous caller", async () => {
    await expect(
      createCategory(null, { name: "Anon", slug: "anon" }),
    ).rejects.toThrow();
  });
});

describe("category tree", () => {
  it("nests three levels and reports depth", async () => {
    const root = await seedCategory("Electronics", "electronics");
    const child = await createCategory(staff, {
      name: "Audio",
      slug: "audio",
      parentId: root.id,
    });
    await createCategory(staff, {
      name: "Over-ear",
      slug: "over-ear",
      parentId: child.id,
    });

    const tree = await getCategoryTree();
    expect(tree).toHaveLength(1);
    expect(tree[0].children[0].children[0].name).toBe("Over-ear");
    expect(tree[0].children[0].children[0].depth).toBe(2);
  });

  it("builds a breadcrumb path", async () => {
    const root = await seedCategory("Electronics", "electronics");
    const child = await createCategory(staff, {
      name: "Audio",
      slug: "audio",
      parentId: root.id,
    });

    const tree = await getCategoryTree();
    const path = findCategoryPath(tree, child.id);
    expect(path.map((node) => node.name)).toEqual(["Electronics", "Audio"]);
  });

  it("collects a subtree for filtering listings", async () => {
    const root = await seedCategory("Electronics", "electronics");
    const child = await createCategory(staff, {
      name: "Audio",
      slug: "audio",
      parentId: root.id,
    });

    const tree = await getCategoryTree();
    expect(collectSubtreeIds(tree[0]).sort()).toEqual(
      [root.id, child.id].sort(),
    );
  });

  it("refuses to move a category inside itself", async () => {
    const root = await seedCategory("Electronics", "electronics");
    await expect(
      updateCategory(staff, root.id, {
        name: "Electronics",
        slug: "electronics",
        parentId: root.id,
      }),
    ).rejects.toThrow(CycleError);
  });

  it("refuses to move a category inside its own descendant", async () => {
    const root = await seedCategory("Electronics", "electronics");
    const child = await createCategory(staff, {
      name: "Audio",
      slug: "audio",
      parentId: root.id,
    });

    await expect(
      updateCategory(staff, root.id, {
        name: "Electronics",
        slug: "electronics",
        parentId: child.id,
      }),
    ).rejects.toThrow(CycleError);
  });

  it("orphans nothing: a category with children cannot be removed", async () => {
    const root = await seedCategory("Electronics", "electronics");
    await createCategory(staff, {
      name: "Audio",
      slug: "audio",
      parentId: root.id,
    });

    await expect(deleteCategory(staff, root.id)).rejects.toThrow(
      CategoryInUseError,
    );
  });

  it("a category holding products cannot be removed", async () => {
    const category = await seedCategory();
    await createProduct(staff, { title: "Headphones", categoryId: category.id });

    await expect(deleteCategory(staff, category.id)).rejects.toThrow(
      CategoryInUseError,
    );
  });

  it("builds a tree from a flat list without querying per level", () => {
    const tree = buildCategoryTree([
      { id: "a", parentId: null, name: "A", slug: "a", sortOrder: 0 },
      { id: "b", parentId: "a", name: "B", slug: "b", sortOrder: 0 },
      { id: "c", parentId: "b", name: "C", slug: "c", sortOrder: 0 },
    ]);
    expect(tree[0].children[0].children[0].id).toBe("c");
  });
});

describe("products", () => {
  it("derives a slug from the title when none is given", async () => {
    const category = await seedCategory();
    const product = await createProduct(staff, {
      title: "Studio Reference Headphones",
      categoryId: category.id,
    });
    expect(product.slug).toBe("studio-reference-headphones");
  });

  it("avoids colliding with an existing slug", async () => {
    const category = await seedCategory();
    await createProduct(staff, { title: "Headphones", categoryId: category.id });
    const second = await createProduct(staff, {
      title: "Headphones",
      categoryId: category.id,
    });
    expect(second.slug).toBe("headphones-2");
  });

  it("starts as a draft, which the public query cannot see", async () => {
    const category = await seedCategory();
    const product = await createProduct(staff, {
      title: "Unreleased",
      categoryId: category.id,
    });

    expect(product.status).toBe("draft");
    await expect(getPublicProductBySlug(product.slug)).resolves.toBeNull();
  });

  it("becomes publicly visible once it is preorder_open", async () => {
    const category = await seedCategory();
    const product = await createProduct(staff, {
      title: "Candy Box",
      categoryId: category.id,
      status: "preorder_open",
    });

    const visible = await getPublicProductBySlug(product.slug);
    expect(visible?.title).toBe("Candy Box");
  });

  /**
   * Archive, never delete — orders reference products (CLAUDE.md section 7).
   */
  it("archiving hides the product and its variants without deleting rows", async () => {
    const category = await seedCategory();
    const product = await createProduct(staff, {
      title: "Candy Box",
      categoryId: category.id,
      status: "preorder_open",
    });

    await harness.db.insert(productVariants).values({
      productId: product.id,
      sku: "CANDY-1",
      priceBdt: 185000,
      fulfillmentMode: "preorder",
    });

    await archiveProduct(staff, product.id);

    await expect(getPublicProductBySlug(product.slug)).resolves.toBeNull();

    const stillThere = await harness.db
      .select()
      .from(products)
      .where(eq(products.id, product.id));
    expect(stillThere).toHaveLength(1);
    expect(stillThere[0].archivedAt).not.toBeNull();

    const variants = await harness.db
      .select()
      .from(productVariants)
      .where(eq(productVariants.productId, product.id));
    expect(variants[0].archivedAt).not.toBeNull();
  });

  it("restores as a draft rather than straight back on sale", async () => {
    const category = await seedCategory();
    const product = await createProduct(staff, {
      title: "Candy Box",
      categoryId: category.id,
      status: "preorder_open",
    });

    await archiveProduct(staff, product.id);
    await restoreProduct(staff, product.id);

    const restored = await getProductForAdmin(staff, product.id);
    expect(restored?.status).toBe("draft");
    expect(restored?.archivedAt).toBeNull();
  });

  it("keeps the slug stable when the title is unchanged", async () => {
    const category = await seedCategory();
    const product = await createProduct(staff, {
      title: "Candy Box",
      categoryId: category.id,
    });

    const updated = await updateProduct(staff, product.id, {
      title: "Candy Box",
      categoryId: category.id,
      brand: "Hometown",
    });

    expect(updated.slug).toBe(product.slug);
  });
});

describe("audit trail", () => {
  it("records who created a product, in the same transaction", async () => {
    const category = await seedCategory();
    const product = await createProduct(staff, {
      title: "Candy Box",
      categoryId: category.id,
    });

    const entries = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, product.id));

    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("product.created");
    expect(entries[0].actorUserId).toBe(staff.id);
  });

  it("records the before and after of an archive", async () => {
    const category = await seedCategory();
    const product = await createProduct(staff, {
      title: "Candy Box",
      categoryId: category.id,
      status: "preorder_open",
    });

    await archiveProduct(staff, product.id);

    const entries = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "product.archived"));

    expect(entries).toHaveLength(1);
    expect(entries[0].beforeJson).toMatchObject({ status: "preorder_open" });
    expect(entries[0].afterJson).toMatchObject({ status: "archived" });
  });
});

describe("attributes", () => {
  it("creates an attribute with its values", async () => {
    const attribute = await createAttribute(staff, {
      name: "Color",
      inputType: "select",
      values: ["Red", "Blue"],
    });

    const values = await harness.db
      .select()
      .from(attributeValues)
      .where(eq(attributeValues.attributeId, attribute.id));

    expect(values.map((v) => v.value).sort()).toEqual(["Blue", "Red"]);
  });

  it("refuses a customer creating an attribute", async () => {
    await expect(
      createAttribute(customer, { name: "Color", inputType: "select" }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("appends new values after the existing ones", async () => {
    const attribute = await createAttribute(staff, {
      name: "Color",
      inputType: "select",
      values: ["Red"],
    });

    const added = await addAttributeValue(staff, attribute.id, "Blue");
    expect(added.sortOrder).toBe(1);
  });

  it("refuses to delete a value a variant already uses", async () => {
    const category = await seedCategory();
    const product = await createProduct(staff, {
      title: "Headphones",
      categoryId: category.id,
    });
    const attribute = await createAttribute(staff, {
      name: "Color",
      inputType: "select",
      values: ["Red"],
    });

    const [value] = await harness.db
      .select()
      .from(attributeValues)
      .where(eq(attributeValues.attributeId, attribute.id));

    const [variant] = await harness.db
      .insert(productVariants)
      .values({
        productId: product.id,
        sku: "HP-RED",
        priceBdt: 100000,
        fulfillmentMode: "preorder",
      })
      .returning();

    await harness.db.insert(variantOptionValues).values({
      variantId: variant.id,
      attributeId: attribute.id,
      attributeValueId: value.id,
    });

    await expect(deleteAttributeValue(staff, value.id)).rejects.toThrow(
      AttributeInUseError,
    );
  });
});
