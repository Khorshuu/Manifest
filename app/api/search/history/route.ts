import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth";
import {
  clearSearchHistory,
  listSearchHistory,
  removeSearchHistory,
} from "@/lib/search/history";
import { searchHistoryEntrySchema } from "@/lib/validation/search";

/**
 * A signed-in customer's own recent searches. A guest gets an empty list and
 * `signedIn: false`, which tells the search box to use the browser's storage
 * instead — not a 401, because not being signed in is not an error here.
 */
export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ signedIn: false, history: [] });

    return NextResponse.json(
      { signedIn: true, history: await listSearchHistory(user) },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** `?q=` removes one search; no `q` clears the whole list. */
export async function DELETE(request: Request) {
  const raw = new URL(request.url).searchParams.get("q");

  try {
    const user = await getCurrentUser();

    if (raw === null) {
      await clearSearchHistory(user);
      return NextResponse.json({ ok: true });
    }

    const parsed = searchHistoryEntrySchema.safeParse({ q: raw });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "That search could not be read." },
        { status: 400 },
      );
    }

    await removeSearchHistory(user, parsed.data.q);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
