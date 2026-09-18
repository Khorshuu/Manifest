/**
 * Search Console intelligence (Stage 6 of the knowledge platform).
 *
 * The whole module is optional. With no provider configured every entry point
 * answers "not connected" and the rest of Manifest — the storefront,
 * SearchPulse, SeoPulse and the Product Knowledge Base — behaves exactly as it
 * did before. What is measured here is internal analytics about this shop's
 * own pages: it is never exported, never a product fact, and never mixed with
 * anything that identifies a customer.
 */
export * from "./config";
export * from "./metrics";
export * from "./sync";
export * from "./opportunities";
export * from "./comparison";
export * from "./learning";
export * from "./listing";
export { pathOf, isOwnAddress, resolvePaths, type ResolvedPath } from "./paths";
