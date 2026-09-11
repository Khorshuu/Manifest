/**
 * Development seed data. Idempotent: it clears the tables it owns, then
 * re-inserts, so it can be run repeatedly against a local database.
 *
 * Run with: npm run db:seed
 */
import { hash } from "@node-rs/argon2";
import { sql } from "drizzle-orm";
/* eslint-disable @typescript-eslint/no-explicit-any -- the schema generic is
   intentionally open so both the postgres-js and PGlite databases satisfy it */
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";
import { taka } from "../lib/money";

const {
  attributes,
  attributeValues,
  categories,
  categoryAttributes,
  productAttributes,
  productImages,
  products,
  productVariants,
  searchSynonyms,
  siteSettings,
  users,
  variantOptionValues,
} = schema;

/**
 * Any Drizzle Postgres database: postgres-js in development, PGlite in tests.
 * The schema generic is deliberately left off — the seed only uses insert and
 * execute, so constraining it further would reject a caller for no reason.
 */
export type SeedDatabase = PgDatabase<PgQueryResultHKT, any>;

export async function seed(db: SeedDatabase) {
  console.log("Clearing seeded tables...");
  await db.execute(sql`
    truncate table
      variant_option_values, variant_images, waitlist_entries,
      inventory_adjustments, product_attributes, product_variants,
      product_images, product_related, product_categories, products,
      categories, attribute_values, attributes, site_settings, users,
      search_synonyms, search_queries
    restart identity cascade
  `);

  console.log("Seeding users...");
  const passwordHash = await hash("password123");
  const [superAdmin, staffAdmin, customer] = await db
    .insert(users)
    .values([
      {
        email: "admin@example.com",
        firstName: "Owner",
        phone: "+8801700000001",
        passwordHash,
        role: "super_admin",
        emailVerifiedAt: new Date(),
      },
      {
        email: "staff@example.com",
        phone: "+8801700000002",
        passwordHash,
        role: "staff_admin",
        emailVerifiedAt: new Date(),
      },
      {
        email: "customer@example.com",
        firstName: "Nadia",
        lastName: "Rahman",
        phone: "+8801700000003",
        passwordHash,
        role: "customer",
        emailVerifiedAt: new Date(),
      },
    ])
    .returning();

  console.log("Seeding category tree (3 levels)...");
  const [snacks, electronics, homeKitchen, outdoors, personalCare] = await db
    .insert(categories)
    .values([
      { name: "Snacks & Groceries", slug: "snacks-groceries", sortOrder: 1 },
      { name: "Electronics", slug: "electronics", sortOrder: 2 },
      { name: "Home & Kitchen", slug: "home-kitchen", sortOrder: 3 },
      { name: "Outdoors & Travel", slug: "outdoors-travel", sortOrder: 4 },
      { name: "Beauty & Care", slug: "beauty-care", sortOrder: 5 },
    ])
    .returning();

  const [candy, headphones] = await db
    .insert(categories)
    .values([
      {
        name: "Candy & Chocolate",
        slug: "candy-chocolate",
        parentId: snacks.id,
        sortOrder: 1,
      },
      {
        name: "Audio",
        slug: "audio",
        parentId: electronics.id,
        sortOrder: 1,
      },
    ])
    .returning();

  const [coffeeGear, packs, skincare] = await db
    .insert(categories)
    .values([
      {
        name: "Coffee & Tea Gear",
        slug: "coffee-tea-gear",
        parentId: homeKitchen.id,
        sortOrder: 1,
      },
      {
        name: "Packs & Bags",
        slug: "packs-bags",
        parentId: outdoors.id,
        sortOrder: 1,
      },
      {
        name: "Skincare",
        slug: "skincare",
        parentId: personalCare.id,
        sortOrder: 1,
      },
    ])
    .returning();

  const [seasonalCandy, overEar] = await db
    .insert(categories)
    .values([
      {
        name: "Seasonal & Limited Edition",
        slug: "seasonal-limited-edition",
        parentId: candy.id,
        sortOrder: 1,
      },
      {
        name: "Over-ear Headphones",
        slug: "over-ear-headphones",
        parentId: headphones.id,
        sortOrder: 1,
      },
    ])
    .returning();

  console.log("Seeding attributes...");
  const [flavor, color] = await db
    .insert(attributes)
    .values([
      { name: "Flavor", inputType: "select" },
      { name: "Color", inputType: "select" },
    ])
    .returning();

  const flavorValues = await db
    .insert(attributeValues)
    .values([
      { attributeId: flavor.id, value: "Pumpkin Spice", sortOrder: 1 },
      { attributeId: flavor.id, value: "Peppermint", sortOrder: 2 },
    ])
    .returning();

  const colorValues = await db
    .insert(attributeValues)
    .values([
      { attributeId: color.id, value: "Midnight Black", sortOrder: 1 },
      { attributeId: color.id, value: "Sandstone", sortOrder: 2 },
    ])
    .returning();

  console.log("Seeding products...");
  const closesAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const arrivalFrom = new Date(Date.now() + 35 * 24 * 60 * 60 * 1000);
  const arrivalTo = new Date(Date.now() + 49 * 24 * 60 * 60 * 1000);

  const [candyProduct, headphoneProduct] = await db
    .insert(products)
    .values([
      {
        categoryId: seasonalCandy.id,
        title: "Seasonal Candy Variety Box",
        slug: "seasonal-candy-variety-box",
        brand: "Hometown Confectionery",
        descriptionHtml:
          "<p>A limited-run seasonal box, sold in the US only and not distributed in Bangladesh.</p>",
        bulletFeatures: [
          "Limited seasonal run, sourced direct from the US",
          "Arrives sealed in original retail packaging",
          "Fixed landed price — shipping and duty already included",
        ],
        specTable: [
          { label: "Net weight", value: "680 g" },
          { label: "Origin", value: "United States" },
        ],
        tags: ["seasonal", "limited"],
        seoMetaTitle: "Seasonal Candy Variety Box — preorder from the US",
        seoMetaDescription:
          "Preorder a limited seasonal US candy box, delivered in Bangladesh at a fixed landed price.",
        status: "preorder_open",
      },
      {
        categoryId: overEar.id,
        title: "Studio Reference Headphones",
        slug: "studio-reference-headphones",
        brand: "Northline Audio",
        descriptionHtml:
          "<p>Open-back reference headphones, hard to source locally and heavily marked up when they do appear.</p>",
        bulletFeatures: [
          "Open-back, 250 ohm reference drivers",
          "Two-year manufacturer warranty honoured through us",
          "Fixed landed price — shipping and duty already included",
        ],
        specTable: [
          { label: "Weight", value: "295 g" },
          { label: "Origin", value: "United States" },
        ],
        tags: ["audio", "preorder"],
        sku: "NL-STUDIO",
        identifierType: "upc",
        identifierValue: "0812345678901",
        boxContents: [
          "1 x Studio Reference Headphones",
          "1 x 3 m coiled cable",
          "1 x 6.35 mm adapter",
          "1 x hard carrying case",
        ],
        warranty: {
          hasWarranty: true,
          durationMonths: 24,
          type: "Manufacturer",
          provider: "Northline Audio",
          description:
            "Covers manufacturing defects in the drivers, headband and cable.",
          terms:
            "Claims are handled through us. Return the headphones with the order number; wear to the earpads is not covered.",
        },
        compliance: {
          certifications: [{ name: "CE", number: "CE-2291-A" }, { name: "RoHS" }],
          safety:
            "Sustained listening above 85 dB can damage hearing. Take a break every hour.",
          countryOfOrigin: "United States",
        },
        details: {
          manufacturer: "Northline Audio",
          modelName: "Studio Reference",
          modelNumber: "NL-SR250",
          material: "Aluminium and velour",
          itemWeight: "295 g",
          packageWeight: "1.1 kg",
          intendedUse: "Mixing and critical listening",
          careInstructions: "Wipe the earpads with a dry cloth.",
        },
        searchKeywords: ["open back", "monitoring", "250 ohm"],
        seoMetaTitle: "Studio Reference Headphones — preorder from the US",
        seoMetaDescription:
          "Preorder open-back studio reference headphones from the US, delivered in Bangladesh.",
        status: "preorder_open",
      },
    ])
    .returning();

  await db.insert(productImages).values([
    {
      productId: candyProduct.id,
      url: "/seed/candy-box.svg",
      altText: "Seasonal candy variety box in its retail packaging",
      sortOrder: 0,
    },
    {
      productId: headphoneProduct.id,
      url: "/seed/headphones.svg",
      altText: "Open-back studio reference headphones, three-quarter view",
      sortOrder: 0,
    },
    {
      productId: headphoneProduct.id,
      url: "/seed/portable-dac-and-amplifier.svg",
      altText: "The headphones beside a portable amplifier",
      sortOrder: 1,
    },
    {
      productId: headphoneProduct.id,
      url: "/seed/desktop-studio-monitors-pair.svg",
      altText: "The headphones on a desk between a pair of studio monitors",
      sortOrder: 0,
      kind: "lifestyle",
    },
  ]);

  /*
   * Specifications defined on a category rather than on the product — the
   * arrangement that lets a new shelf describe itself without a migration.
   * Defined on the parent, answered by a product two levels down.
   */
  const [impedance, backing] = await db
    .insert(categoryAttributes)
    .values([
      {
        categoryId: electronics.id,
        name: "Impedance",
        dataType: "number",
        unit: "ohm",
        sortOrder: 0,
      },
      {
        categoryId: overEar.id,
        name: "Earcup backing",
        dataType: "select",
        options: ["Open", "Closed", "Semi-open"],
        sortOrder: 0,
      },
    ])
    .returning();

  await db
    .update(products)
    .set({
      attributeValues: {
        [impedance.id]: "250",
        [backing.id]: "Open",
      },
    })
    .where(sql`${products.id} = ${headphoneProduct.id}`);

  await db.insert(productAttributes).values([
    { productId: candyProduct.id, attributeId: flavor.id, sortOrder: 0 },
    { productId: headphoneProduct.id, attributeId: color.id, sortOrder: 0 },
  ]);

  console.log("Seeding variants...");
  const candyVariants = await db
    .insert(productVariants)
    .values(
      flavorValues.map((_value, i) => ({
        productId: candyProduct.id,
        sku: `CANDY-BOX-${i + 1}`,
        priceBdt: taka(1850),
        costPriceUsd: 1200,
        weightGrams: 680,
        fulfillmentMode: "preorder" as const,
        // Deliberately ample. The end-to-end suite buys from this product
        // repeatedly, and a tight capacity would have it selling out mid-run —
        // the sold-out path is covered by the headphones instead.
        preorderCapacity: 500,
        preorderReserved: i === 0 ? 12 : 0,
        preorderClosesAt: closesAt,
        estimatedArrivalFrom: arrivalFrom,
        estimatedArrivalTo: arrivalTo,
        paymentMode: "full" as const,
      })),
    )
    .returning();

  const headphoneVariants = await db
    .insert(productVariants)
    .values(
      colorValues.map((_value, i) => ({
        productId: headphoneProduct.id,
        sku: `NL-STUDIO-${i + 1}`,
        priceBdt: taka(31500),
        // The first colourway is on offer, so the sale price, the struck
        // through regular price and the discount badge all have something
        // real behind them.
        salePriceBdt: i === 0 ? taka(28900) : null,
        saleEndsAt: i === 0 ? closesAt : null,
        costPriceUsd: 21000,
        weightGrams: 295,
        fulfillmentMode: "preorder" as const,
        preorderCapacity: 10,
        preorderReserved: i === 1 ? 10 : 3,
        preorderClosesAt: closesAt,
        estimatedArrivalFrom: arrivalFrom,
        estimatedArrivalTo: arrivalTo,
        paymentMode: "deposit" as const,
        depositPercent: 40,
      })),
    )
    .returning();

  await db.insert(variantOptionValues).values([
    ...candyVariants.map((variant, i) => ({
      variantId: variant.id,
      attributeId: flavor.id,
      attributeValueId: flavorValues[i].id,
    })),
    ...headphoneVariants.map((variant, i) => ({
      variantId: variant.id,
      attributeId: color.id,
      attributeValueId: colorValues[i].id,
    })),
  ]);

  // Options belong to the product they describe (migration 0020, D-040):
  // the shared Flavor and Color above become each product's own.
  await db.execute("select scope_product_attributes()");

  /**
   * A wider catalogue.
   *
   * Two products made every listing page look like a shop that had not opened
   * yet, which is a design problem no amount of layout fixes. These carry real
   * prices, real windows and real capacity, so every figure on the site stays
   * a figure from the database.
   */
  console.log("Seeding the wider catalogue...");

  const catalogue = [
    {
      title: "Maple Pecan Coffee Beans",
      brand: "Cascade Roasters",
      categoryId: snacks.id,
      taka: 2400,
      weight: 500,
      days: 9,
      summary:
        "A medium roast finished with maple and toasted pecan, roasted in Oregon and shipped whole bean so it is still fresh when it lands.",
      bullets: [
        "Roasted to order, never sitting in a warehouse",
        "Whole bean, 500g, valve-sealed",
        "Tasting notes: maple, pecan, brown sugar",
      ],
      specs: [
        ["Roast", "Medium"],
        ["Form", "Whole bean"],
        ["Net weight", "500 g"],
        ["Origin", "Oregon, United States"],
      ],
    },
    {
      title: "Sour Cherry Gummy Tin",
      brand: "Hometown Confectionery",
      categoryId: candy.id,
      taka: 1250,
      weight: 400,
      days: 2,
      summary:
        "Sharp sour cherry gummies in a collectible tin. A small seasonal run that sells out quickly in the United States.",
      bullets: [
        "Real fruit juice, no artificial colour",
        "Reusable steel tin",
        "Limited seasonal production",
      ],
      specs: [
        ["Net weight", "400 g"],
        ["Packaging", "Steel tin"],
        ["Allergens", "None declared"],
      ],
    },
    {
      title: "Dark Chocolate Sea Salt Bars",
      brand: "Ridgeline Cocoa",
      categoryId: candy.id,
      taka: 1650,
      weight: 350,
      days: 21,
      summary:
        "Three 72% cacao bars finished with flaked sea salt, made in small batches from single-origin beans.",
      bullets: [
        "72% cacao, single origin",
        "Three bars per pack",
        "Flaked sea salt finish",
      ],
      specs: [
        ["Cacao", "72%"],
        ["Bars", "3 × 100 g"],
        ["Storage", "Cool and dry"],
      ],
    },
    {
      title: "Small-Batch Hot Sauce Trio",
      brand: "Delta Pepper Co.",
      categoryId: snacks.id,
      taka: 2150,
      weight: 900,
      days: 12,
      summary:
        "Three bottles across the heat range — smoked chipotle, habanero lime, and a ghost pepper for people who mean it.",
      bullets: [
        "Three 150ml bottles",
        "Fermented, not vinegar-forward",
        "Mild, hot, and very hot",
      ],
      specs: [
        ["Bottles", "3 × 150 ml"],
        ["Heat", "Mild to very hot"],
        ["Shelf life", "18 months unopened"],
      ],
    },
    {
      title: "Vermont Pancake Syrup",
      brand: "Northfield Supply",
      categoryId: snacks.id,
      taka: 1950,
      weight: 750,
      days: 30,
      summary:
        "Grade A amber maple syrup from a single Vermont sugarhouse. Nothing added, nothing blended.",
      bullets: [
        "100% pure maple syrup",
        "Grade A, amber colour, rich taste",
        "750ml glass jug",
      ],
      specs: [
        ["Volume", "750 ml"],
        ["Grade", "A — amber, rich"],
        ["Origin", "Vermont, United States"],
      ],
    },
    {
      title: "Cold Brew Concentrate Case",
      brand: "Cascade Roasters",
      categoryId: snacks.id,
      taka: 3400,
      weight: 2000,
      days: 6,
      summary:
        "Twelve cans of unsweetened cold brew concentrate. One can makes two long glasses over ice.",
      bullets: [
        "12 cans, unsweetened",
        "Steeped 18 hours",
        "Shelf stable until opened",
      ],
      specs: [
        ["Cans", "12 × 250 ml"],
        ["Sugar", "None"],
        ["Caffeine", "180 mg per can"],
      ],
    },
    {
      title: "Wireless Earbuds, Second Edition",
      brand: "Northlake Audio",
      categoryId: headphones.id,
      taka: 18500,
      weight: 220,
      days: 16,
      summary:
        "Active noise cancelling earbuds with a charging case, eight hours a charge, and a fit kit in four sizes.",
      bullets: [
        "Active noise cancelling",
        "8 hours a charge, 32 with the case",
        "Four ear tip sizes included",
      ],
      specs: [
        ["Battery", "8 h buds, 32 h with case"],
        ["Charging", "USB-C and wireless"],
        ["Water rating", "IPX4"],
      ],
    },
    {
      title: "Portable DAC and Amplifier",
      brand: "Northlake Audio",
      categoryId: headphones.id,
      taka: 24500,
      weight: 180,
      days: 25,
      summary:
        "A pocket amplifier that drives high-impedance headphones properly from a laptop or a phone.",
      bullets: [
        "Drives up to 300 ohm headphones",
        "USB-C in, 3.5mm and 4.4mm out",
        "Machined aluminium body",
      ],
      specs: [
        ["Output", "3.5 mm and 4.4 mm balanced"],
        ["Impedance", "16 – 300 ohm"],
        ["Weight", "180 g"],
      ],
    },
    {
      title: "Desktop Studio Monitors, Pair",
      brand: "Harbor Acoustics",
      categoryId: headphones.id,
      taka: 46500,
      weight: 6000,
      days: 11,
      summary:
        "Near-field monitors for a desk, sold as a matched pair. Flat response, no flattering bass lift.",
      bullets: [
        "Matched pair, near-field",
        "4-inch woofer, silk dome tweeter",
        "Balanced and unbalanced inputs",
      ],
      specs: [
        ["Driver", "4 in woofer, 1 in tweeter"],
        ["Response", "56 Hz – 22 kHz"],
        ["Inputs", "XLR, TRS, RCA"],
      ],
    },
    {
      title: "Mechanical Keyboard, Tactile",
      brand: "Foundry Peripherals",
      categoryId: electronics.id,
      taka: 15900,
      weight: 1100,
      days: 3,
      summary:
        "A 75% mechanical keyboard with tactile switches, a machined case, and keycaps that will not fade.",
      bullets: [
        "75% layout with arrow keys",
        "Hot-swappable tactile switches",
        "Double-shot PBT keycaps",
      ],
      specs: [
        ["Layout", "75%"],
        ["Switches", "Tactile, hot-swappable"],
        ["Connection", "USB-C, detachable"],
      ],
    },
    {
      title: "Anodised Aluminium Desk Lamp",
      brand: "Foundry Peripherals",
      categoryId: electronics.id,
      taka: 12750,
      weight: 1400,
      days: 19,
      summary:
        "A counterweighted desk lamp with adjustable colour temperature, in anodised aluminium rather than painted steel.",
      bullets: [
        "2700K to 5000K, stepless",
        "Counterweighted arm, no springs to sag",
        "Anodised aluminium",
      ],
      specs: [
        ["Colour temperature", "2700 – 5000 K"],
        ["Output", "800 lumens"],
        ["Finish", "Anodised aluminium"],
      ],
    },
    {
      title: "Field Recorder, 32-bit Float",
      brand: "Harbor Acoustics",
      categoryId: electronics.id,
      taka: 38900,
      weight: 700,
      days: 27,
      summary:
        "A handheld recorder that captures in 32-bit float, so a take that clips can still be recovered afterwards.",
      bullets: [
        "32-bit float recording",
        "Detachable stereo microphone",
        "Records to microSD, up to 1TB",
      ],
      specs: [
        ["Format", "32-bit float WAV"],
        ["Sample rate", "Up to 192 kHz"],
        ["Power", "AA or USB-C"],
      ],
    },
    {
      title: "Gooseneck Pour-Over Kettle",
      brand: "Bellwether Kitchen",
      categoryId: coffeeGear.id,
      taka: 8900,
      weight: 1200,
      days: 5,
      summary:
        "A counterbalanced gooseneck kettle that holds a thin, steady stream, with a thermometer set into the lid rather than clipped on.",
      bullets: [
        "Counterbalanced handle, pours without wrist strain",
        "Lid-mounted thermometer, 40 to 100 °C",
        "Brushed stainless, no interior coating to flake",
      ],
      specs: [
        ["Capacity", "1.0 L"],
        ["Material", "304 stainless steel"],
        ["Base", "Induction compatible"],
      ],
    },
    {
      title: "Hand Grinder, Conical Steel Burr",
      brand: "Bellwether Kitchen",
      categoryId: coffeeGear.id,
      taka: 11400,
      weight: 640,
      days: 12,
      summary:
        "A hand grinder with a hardened conical burr and a numbered adjustment ring, so a setting can be written down and returned to.",
      bullets: [
        "Hardened conical steel burr",
        "Numbered detents, espresso through French press",
        "Folds flat enough for a carry-on",
      ],
      specs: [
        ["Burr", "38 mm conical, hardened steel"],
        ["Settings", "36 numbered detents"],
        ["Hopper", "25 g"],
      ],
    },
    {
      title: "Pre-Seasoned Cast Iron Skillet",
      brand: "Ridgeline Forge",
      categoryId: homeKitchen.id,
      taka: 6800,
      weight: 3200,
      days: 16,
      summary:
        "A 12-inch skillet milled smooth before seasoning, which is the difference between a pan that releases food and one that does not.",
      bullets: [
        "Cooking surface milled smooth, then seasoned",
        "Two pour spouts and a helper handle",
        "Oven, grill and open fire",
      ],
      specs: [
        ["Diameter", "30 cm"],
        ["Weight", "3.2 kg"],
        ["Finish", "Milled, pre-seasoned"],
      ],
    },
    {
      title: "Vacuum Insulated Carafe",
      brand: "Bellwether Kitchen",
      categoryId: homeKitchen.id,
      taka: 5200,
      weight: 850,
      days: 22,
      summary:
        "A carafe that holds coffee at temperature for most of a working day without the stewed taste a hotplate gives it.",
      bullets: [
        "Holds above 70 °C for eight hours",
        "One-handed pour, lid stays on",
        "Dismantles fully for cleaning",
      ],
      specs: [
        ["Capacity", "1.2 L"],
        ["Retention", "8 hours above 70 °C"],
        ["Body", "Double-walled stainless"],
      ],
    },
    {
      title: "Weatherproof Daypack, 22 Litre",
      brand: "Corvid Supply",
      categoryId: packs.id,
      taka: 9600,
      weight: 980,
      days: 7,
      summary:
        "A roll-top daypack in recycled sailcloth, with a laptop sleeve that sits off the floor and seams taped rather than merely coated.",
      bullets: [
        "Roll-top closure, taped seams",
        "Suspended 16-inch laptop sleeve",
        "Recycled sailcloth, 400D",
      ],
      specs: [
        ["Volume", "22 L"],
        ["Fabric", "400D recycled sailcloth"],
        ["Laptop", "Up to 16 inches"],
      ],
    },
    {
      title: "Packable Down Jacket",
      brand: "Corvid Supply",
      categoryId: outdoors.id,
      taka: 14200,
      weight: 420,
      days: 25,
      summary:
        "800-fill responsibly sourced down in a ripstop shell, which packs into its own chest pocket and comes out without creases.",
      bullets: [
        "800-fill responsibly sourced down",
        "Packs into its own chest pocket",
        "20D ripstop shell, DWR finish",
      ],
      specs: [
        ["Fill power", "800"],
        ["Shell", "20D ripstop nylon"],
        ["Packed size", "18 × 14 cm"],
      ],
    },
    {
      title: "Titanium Camp Cookset",
      brand: "Ridgeline Forge",
      categoryId: outdoors.id,
      taka: 7300,
      weight: 245,
      days: 11,
      summary:
        "A nesting titanium pot and cup that together weigh less than a full water bottle and will not hold the taste of last night's dinner.",
      bullets: [
        "Grade 1 titanium, no coating",
        "Pot, cup and lid nest together",
        "Folding handles lock in place",
      ],
      specs: [
        ["Pot", "750 ml"],
        ["Cup", "450 ml"],
        ["Total weight", "245 g"],
      ],
    },
    {
      title: "Mineral Sunscreen SPF 50",
      brand: "Pale Coast",
      categoryId: skincare.id,
      taka: 2650,
      weight: 120,
      days: 4,
      summary:
        "A non-nano zinc sunscreen formulated for humidity, which is the reason most imported sunscreens fail here rather than the SPF number.",
      bullets: [
        "Non-nano zinc oxide, 22%",
        "Reef-safe formulation",
        "No white cast on medium and deep skin",
      ],
      specs: [
        ["SPF", "50, broad spectrum"],
        ["Active", "22% non-nano zinc oxide"],
        ["Volume", "100 ml"],
      ],
    },
    {
      title: "Ceramide Repair Cream",
      brand: "Pale Coast",
      categoryId: skincare.id,
      taka: 4300,
      weight: 95,
      days: 18,
      summary:
        "A fragrance-free barrier cream with ceramides in the ratio skin actually uses, in a tube rather than a jar that gets contaminated.",
      bullets: [
        "Ceramides in a 3:1:1 ratio",
        "Fragrance-free, no essential oils",
        "Airless tube, no jar dipping",
      ],
      specs: [
        ["Volume", "60 ml"],
        ["Fragrance", "None"],
        ["Suitable for", "Compromised barrier"],
      ],
    },
    {
      title: "Cold-Pressed Beard Oil",
      brand: "Pale Coast",
      categoryId: personalCare.id,
      taka: 2100,
      weight: 80,
      days: 29,
      summary:
        "Jojoba and argan pressed without heat, lightly scented with cedar, in an amber bottle because the oils degrade in clear glass.",
      bullets: [
        "Cold-pressed jojoba and argan",
        "Cedar and black pepper, lightly scented",
        "Amber glass with a glass dropper",
      ],
      specs: [
        ["Volume", "30 ml"],
        ["Base oils", "Jojoba, argan"],
        ["Scent", "Cedar, black pepper"],
      ],
    },
  ];

  const extraProducts = await db
    .insert(products)
    .values(
      catalogue.map((entry) => ({
        categoryId: entry.categoryId,
        title: entry.title,
        slug: entry.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/(^-|-$)/g, ""),
        brand: entry.brand,
        descriptionHtml: `<p>${entry.summary}</p><p>Bought direct from an American retailer and shipped to Bangladesh at a fixed landed price — freight and customs duty are already inside the figure you see.</p>`,
        bulletFeatures: entry.bullets,
        specTable: entry.specs.map(([label, value]) => ({ label, value })),
        seoMetaTitle: `${entry.title} — preorder from the US`,
        seoMetaDescription: entry.summary,
        status: "preorder_open" as const,
      })),
    )
    .returning();

  await db.insert(productImages).values(
    extraProducts.map((product) => ({
      productId: product.id,
      url: `/seed/${product.slug}.svg`,
      altText: `${product.title}, product illustration`,
      sortOrder: 0,
    })),
  );

  await db.insert(productVariants).values(
    extraProducts.map((product, index) => {
      const entry = catalogue[index];
      const capacity = 20 + ((index * 7) % 40);

      return {
        productId: product.id,
        sku: `${product.slug.toUpperCase().slice(0, 18)}-1`,
        priceBdt: taka(entry.taka),
        // Roughly two thirds of the landed price, which is what a real
        // sourcing cost looks like once freight and duty are inside.
        costPriceUsd: Math.round((entry.taka * 0.55) / 120) * 100,
        weightGrams: entry.weight,
        fulfillmentMode: "preorder" as const,
        preorderCapacity: capacity,
        // Varied, so the listings show a spread rather than one number.
        preorderReserved: Math.min(capacity, (index * 5) % capacity),
        preorderClosesAt: new Date(Date.now() + entry.days * 24 * 60 * 60 * 1000),
        estimatedArrivalFrom: new Date(
          Date.now() + (entry.days + 21) * 24 * 60 * 60 * 1000,
        ),
        estimatedArrivalTo: new Date(
          Date.now() + (entry.days + 35) * 24 * 60 * 60 * 1000,
        ),
        paymentMode: "full" as const,
      };
    }),
  );

  /*
   * A handful of synonyms for this catalogue's own vocabulary — the words a
   * Bangladeshi shopper uses for goods the American listings name
   * differently. Configuration, not data: staff edit or remove them at
   * /admin/search, and none maps one kind of product onto another.
   */
  console.log("Seeding search synonyms...");
  await db
    .insert(searchSynonyms)
    .values([
      { term: "sweets", synonyms: ["candy"], bidirectional: true, createdBy: staffAdmin.id },
      { term: "earbuds", synonyms: ["earphones"], bidirectional: true, createdBy: staffAdmin.id },
      { term: "flask", synonyms: ["carafe", "thermos"], bidirectional: false, createdBy: staffAdmin.id },
      { term: "rucksack", synonyms: ["daypack", "backpack"], bidirectional: false, createdBy: staffAdmin.id },
      { term: "frying pan", synonyms: ["skillet"], bidirectional: false, createdBy: staffAdmin.id },
      { term: "sunblock", synonyms: ["sunscreen"], bidirectional: true, createdBy: staffAdmin.id },
    ])
    .onConflictDoNothing();

  console.log("Seeding site settings...");
  await db.insert(siteSettings).values([
    {
      key: "store.contact_email",
      valueJson: { value: "hello@example.com" },
      updatedBy: superAdmin.id,
    },
    {
      key: "preorder.default_deposit_percent",
      valueJson: { value: 40 },
      updatedBy: superAdmin.id,
    },
  ]);

  console.log(
    [
      "",
      "Seed complete:",
      `  users              3 (${superAdmin.email} / ${staffAdmin.email} / ${customer.email}, password: password123)`,
      "  categories         13 (3 levels deep)",
      "  attributes         2 with 4 values",
      `  products           ${2 + catalogue.length}, all preorder_open`,
      `  variants           ${candyVariants.length + headphoneVariants.length} (one is deliberately at full capacity, to exercise the waitlist path)`,
      "",
    ].join("\n"),
  );

  return {
    users: 3,
    categories: 13,
    products: 2,
    variants: candyVariants.length + headphoneVariants.length,
  };
}
