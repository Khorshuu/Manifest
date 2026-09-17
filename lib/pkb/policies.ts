import { pkbVerificationPolicies, type PkbRegistryRole, type PkbSourceType } from "@/db/schema";
import type { Executor } from "./common";

/**
 * The starting verification policies (A-4, D-072).
 *
 * None of them makes a source trusted by itself. Official manufacturer
 * evidence counts only from a domain someone approved for the product's brand
 * in the source registry; a feed counts only if approved there; an official
 * document counts because a staff member recorded it as official. Accepting a
 * value as VERIFIED is still a person's action on that value.
 *
 * Created when missing, never overwritten: a policy an owner retired or
 * edited stays as they left it.
 */

type DefaultPolicy = {
  key: string;
  name: string;
  description: string;
  status: "active" | "draft";
  qualifyingSourceTypes: PkbSourceType[];
  registryRoles: PkbRegistryRole[] | null;
  maxAuthorityTier: number | null;
  minIndependentSources: number;
};

export const DEFAULT_POLICIES: DefaultPolicy[] = [
  {
    key: "official_manufacturer_documentation",
    name: "Official manufacturer documentation",
    description:
      "A value stated on the manufacturer's own product, support or documentation site, on a domain approved for the product's brand.",
    status: "active",
    qualifyingSourceTypes: ["manufacturer_website", "manufacturer_documentation", "manufacturer_support"],
    registryRoles: ["official_product", "official_support", "official_documentation"],
    maxAuthorityTier: 1,
    minIndependentSources: 1,
  },
  {
    key: "approved_manufacturer_or_supplier_feed",
    name: "Approved manufacturer or supplier feed",
    description: "A value delivered by a manufacturer or supplier feed approved in the source registry.",
    status: "active",
    qualifyingSourceTypes: ["manufacturer_feed", "supplier_feed"],
    registryRoles: ["manufacturer_feed", "supplier_feed"],
    maxAuthorityTier: 2,
    minIndependentSources: 1,
  },
  {
    key: "admin_provided_official_document",
    name: "Official document provided by an admin",
    description:
      "A value quoted from an official document (a manufacturer spec sheet, a certificate) that a staff member recorded as official.",
    status: "active",
    qualifyingSourceTypes: ["admin_official_document"],
    registryRoles: null,
    maxAuthorityTier: null,
    minIndependentSources: 1,
  },
  {
    key: "two_trusted_secondary_sources",
    name: "Two independent trusted secondary sources",
    description:
      "The same value from two independent approved distributors, trusted retailers or product databases. Off until someone activates it.",
    status: "draft",
    qualifyingSourceTypes: ["authorized_distributor", "retailer", "product_database"],
    registryRoles: ["authorized_distributor", "trusted_retailer", "product_database"],
    maxAuthorityTier: 2,
    minIndependentSources: 2,
  },
];

export async function ensureDefaultPolicies(executor: Executor): Promise<void> {
  const existing: { key: string }[] = await executor.select({ key: pkbVerificationPolicies.key }).from(pkbVerificationPolicies);
  const have = new Set(existing.map((row) => row.key));
  const missing = DEFAULT_POLICIES.filter((policy) => !have.has(policy.key));
  if (missing.length === 0) return;
  const now = new Date();
  await executor
    .insert(pkbVerificationPolicies)
    .values(
      missing.map((policy) => ({
        ...policy,
        appliesTo: "any" as const,
        origin: "MANIFEST_CREATED" as const,
        activatedAt: policy.status === "active" ? now : null,
      })),
    )
    .onConflictDoNothing();
}
