import type { SearchConsoleConnection, SearchConsoleFetch, SearchConsoleProvider } from "./types";

const MESSAGE =
  "Search Console is not connected. Set SEARCH_CONSOLE_PROVIDER and the credentials for it to see how Google reports these pages.";

/**
 * The default: no Search Console. Everything else keeps working; the screens
 * say "Search Console not connected" and the opportunity engine reports that
 * it has no measurements rather than inventing any.
 */
export class UnconfiguredSearchConsoleProvider implements SearchConsoleProvider {
  readonly key = "none";

  connection(): SearchConsoleConnection {
    return { status: "NOT_CONFIGURED", message: MESSAGE };
  }

  async fetchPerformance(): Promise<SearchConsoleFetch> {
    return { status: "NOT_CONFIGURED", message: MESSAGE };
  }
}
