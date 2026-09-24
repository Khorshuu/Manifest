import type { Metadata } from "next";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { SourcesPanel } from "../panels/sources-panel";

/*
 * Cache Components (DECISIONS.md D-054): allowed to block while this route is
 * converted to cached data plus streamed per-request parts.
 */
export const instant = false;

export const metadata: Metadata = { title: "Sources & Policies · Intelligence" };

/**
 * Reading the trust rules is a catalogue permission, as it has always been on
 * the Knowledge screen. Every decision on this tab asks for `knowledge.manage`
 * instead, and each API route checks it again.
 */
export default async function IntelligenceSourcesPage() {
  const user = await requireAdminPage("catalog.manage");
  return <SourcesPanel user={user} />;
}
