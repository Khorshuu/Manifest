/**
 * The product list's filters, shared by the server page (which reads them
 * from the address) and the client list (which edits them).
 *
 * Kept out of the "use client" list component on purpose: a server component
 * cannot read a plain value exported from a client module — it receives a
 * reference instead — which once left every default undefined on first load,
 * so archived products showed under "All (not archived)".
 */

export type Sort =
  | "updated"
  | "created"
  | "name_asc"
  | "name_desc"
  | "price_asc"
  | "price_desc"
  | "stock_asc";

export type Filters = {
  q: string;
  status: "all" | "published" | "draft" | "archived";
  stock: "all" | "in_stock" | "low" | "out";
  category: string;
  sort: Sort;
};

export const DEFAULT_FILTERS: Filters = {
  q: "",
  status: "all",
  stock: "all",
  category: "",
  sort: "updated",
};

export const STATUS_FILTERS = ["all", "published", "draft", "archived"] as const;
export const STOCK_FILTERS = ["all", "in_stock", "low", "out"] as const;
export const SORTS = [
  "updated",
  "created",
  "name_asc",
  "name_desc",
  "price_asc",
  "price_desc",
  "stock_asc",
] as const;
