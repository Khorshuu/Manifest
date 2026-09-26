import type { DocumentExtractionResult, ProductDocumentExtractionProvider } from "./types";

/**
 * The default: no intelligent reading. Every document is still read by the
 * deterministic extractors, exactly as before (D-123).
 */
export class UnconfiguredExtractionProvider implements ProductDocumentExtractionProvider {
  readonly key = "none";

  async extract(): Promise<DocumentExtractionResult> {
    return {
      status: "NOT_CONFIGURED",
      message: "Intelligent document extraction is not configured. Pages are read by the structured readers only.",
    };
  }
}
