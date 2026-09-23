import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { products } from "@/db/schema";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { can } from "@/lib/auth/authorize";
import { getProductIntelligence } from "@/lib/pkb/intelligence";
import { getVocabularyView } from "@/lib/pkb/intelligence";
import { listingKeywordMigration } from "@/lib/pkb";
import { KeywordAliasesPanel } from "../keyword-aliases-panel";
import { IntelligencePanels } from "./panels";

/*
 * Cache Components (DECISIONS.md D-054): allowed to block while this route is
 * converted to cached data plus streamed per-request parts.
 */
export const instant = false;

export const metadata: Metadata = { title: "Product intelligence" };

/**
 * Everything known about one product, and where each part came from.
 *
 * The screen is deliberately a review queue rather than an editor: proposed
 * values are accepted or rejected one at a time, with the evidence beside
 * them, and a value is only marked verified when a policy says the evidence is
 * enough. There is no "apply everything".
 */
export default async function ProductIntelligencePage({ params }: PageProps<"/admin/products/[productId]/intelligence">) {
  const user = await requireAdminPage("catalog.manage");
  const { productId } = await params;

  const [listing] = await db
    .select({ id: products.id, title: products.title, pkbProductId: products.pkbProductId })
    .from(products)
    .where(eq(products.id, productId));
  if (!listing) notFound();
  if (!listing.pkbProductId) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="font-display text-2xl text-ink">{listing.title}</h1>
        <p className="max-w-2xl text-sm text-ink/70">
          This listing has no knowledge record yet. It is created the next time the listing is saved, or by the
          knowledge sync job, which runs every few minutes.
        </p>
        <Link className="text-sm text-blue-600 hover:underline" href={`/admin/products/${productId}`}>
          Back to the listing
        </Link>
      </div>
    );
  }

  const intelligence = await getProductIntelligence(user, listing.pkbProductId);
  if (!intelligence) notFound();
  const vocabulary = await getVocabularyView(user);
  const keywords = await listingKeywordMigration(user, productId);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p className="text-[0.75rem] uppercase tracking-wide text-ink/55">Product intelligence</p>
        <h1 className="font-display text-2xl text-ink">{intelligence.listingTitle ?? intelligence.name}</h1>
        <Link className="text-sm text-blue-600 hover:underline" href={`/admin/products/${productId}`}>
          Back to the listing
        </Link>
      </header>

      <IntelligencePanels
        intelligence={intelligence}
        definitions={vocabulary.definitions}
        mayDecideVocabulary={can(user, "knowledge.manage")}
      />

      <KeywordAliasesPanel productId={productId} terms={keywords.terms} />
    </div>
  );
}
