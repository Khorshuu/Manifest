import type { Metadata } from "next";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { OverviewPanel } from "./panels/overview-panel";

/*
 * Cache Components (DECISIONS.md D-054): allowed to block while this route is
 * converted to cached data plus streamed per-request parts.
 */
export const instant = false;

export const metadata: Metadata = { title: "Intelligence" };

/**
 * The workspace's front page. The layout has already turned away anyone who
 * can open no tab at all; each section of the overview asks for its own
 * permission before it is loaded.
 */
export default async function IntelligenceOverviewPage() {
  const user = await requireAdminPage();
  return <OverviewPanel user={user} />;
}
