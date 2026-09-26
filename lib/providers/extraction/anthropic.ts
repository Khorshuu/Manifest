import Anthropic from "@anthropic-ai/sdk";
import {
  CANDIDATE_KINDS,
  type CandidateKind,
  type DocumentExtractionRequest,
  type DocumentExtractionResult,
  type ExtractionCandidate,
  type ProductDocumentExtractionProvider,
} from "./types";

/**
 * Claude, reading one document Manifest retrieved (D-123).
 *
 * It is told to quote, not to know. The answer is structured JSON, and it is
 * still only a list of pointers into the text: `lib/pkb/grounding.ts` throws
 * away any candidate whose excerpt is not in the document, whose value the
 * excerpt does not state, or whose numbers the excerpt does not contain.
 *
 * UNVERIFIED against the live API — no ANTHROPIC_API_KEY was available while
 * this was built. The request shape follows the SEO Pulse provider, which uses
 * the same SDK call; the tests drive the pipeline through a fake provider.
 */

/** The document text sent, at most. A product page's visible text is far shorter. */
const MAX_TEXT = 60_000;

const SYSTEM_PROMPT = `You read one product document for an online shop and list what it states about the product. You do not know anything about the product except what the document says.

Rules:
- Use only the document text you are given. Never add knowledge of your own, never infer, never complete a list, never convert units, never round.
- Every candidate must quote the document: "excerpt" is a passage copied exactly, character for character, from the document text, and it must itself state the value. If you cannot copy a passage that states it, leave the candidate out.
- "value" is what the excerpt states, in the document's own words and numbers. Keep units as written.
- "label" is the page's own label when it has one (a table heading, "Ingredients", "Net weight"); otherwise a short plain name for the property (two to four words), for example "Gray coverage" or "Processing time".
- "meaning": the kind of attribute this is, in a few words, or null.
- "kind":
  identity — the product's name, brand, model number, part number, barcode, SKU;
  product_fact — a property of the product itself;
  variant_fact — a property of one version only (a shade, colour, size, flavour) — only for the version named as this product's, if one is named;
  box_content — one item that comes in the package (one candidate per item);
  composition — ingredients, materials, formulation;
  compatibility_use — what it is for, what it works with, how it is used;
  warning_safety — a warning, a precaution, an age limit;
  marketing — a claim of superiority, a slogan, a review, a price, a promotion, delivery or availability.
- Prices, discounts, stock, shipping, ratings and reviews are never product facts: mark them marketing or leave them out.
- If the document is about several versions and names this product's version, report version-specific facts only for that version.
- Prefer fewer, precise candidates over many vague ones. An empty list is a correct answer for a document that states nothing about the product.`;

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "value", "unit", "excerpt", "section", "meaning", "kind"],
        properties: {
          label: { type: "string" },
          value: { type: "string" },
          unit: { anyOf: [{ type: "string" }, { type: "null" }] },
          excerpt: { type: "string" },
          section: { anyOf: [{ type: "string" }, { type: "null" }] },
          meaning: { anyOf: [{ type: "string" }, { type: "null" }] },
          kind: { type: "string", enum: [...CANDIDATE_KINDS] },
        },
      },
    },
  },
} as const;

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

/** The answer, reduced to well-formed candidates. Anything malformed is dropped, not repaired. */
export function readCandidates(raw: unknown, max: number): ExtractionCandidate[] {
  const list = raw && typeof raw === "object" ? (raw as { candidates?: unknown }).candidates : null;
  if (!Array.isArray(list)) return [];
  const found: ExtractionCandidate[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const label = text(record.label, 80);
    const value = text(record.value, 400);
    const excerpt = text(record.excerpt, 1_500);
    const kind = record.kind as CandidateKind;
    if (!label || !value || !excerpt || !CANDIDATE_KINDS.includes(kind)) continue;
    found.push({
      label,
      value,
      excerpt,
      kind,
      unit: text(record.unit, 20),
      section: text(record.section, 120),
      meaning: text(record.meaning, 80),
    });
    if (found.length >= max) break;
  }
  return found;
}

export class AnthropicExtractionProvider implements ProductDocumentExtractionProvider {
  readonly key = "anthropic";
  private readonly client: Anthropic | null;

  constructor(
    apiKey: string | undefined,
    private readonly model: string,
  ) {
    this.client = apiKey ? new Anthropic({ apiKey, timeout: 120_000, maxRetries: 1 }) : null;
  }

  async extract(request: DocumentExtractionRequest): Promise<DocumentExtractionResult> {
    if (!this.client) {
      return { status: "UNAVAILABLE", message: "ANTHROPIC_API_KEY is not set, so intelligent document extraction cannot run." };
    }

    const truncated = request.document.text.length > MAX_TEXT;
    const body = request.document.text.slice(0, MAX_TEXT);
    const context = [
      `Product: ${request.product.name}`,
      request.product.brand ? `Brand: ${request.product.brand}` : null,
      request.product.family ? `Kind of product: ${request.product.family}` : null,
      request.product.variant ? `This product's version: ${request.product.variant}` : null,
      request.knownLabels.length > 0 ? `Labels this shop already uses for such products: ${request.knownLabels.slice(0, 60).join("; ")}` : null,
      `List at most ${request.maxCandidates} candidates.`,
    ]
      .filter(Boolean)
      .join("\n");

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: 16000,
        output_config: { effort: "medium", format: { type: "json_schema", schema: RESPONSE_SCHEMA } },
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `${context}\n\n<document url="${request.document.url ?? ""}" title="${(request.document.title ?? "").replace(/"/g, "'")}"${truncated ? ' truncated="true"' : ""}>\n${body}\n</document>`,
          },
        ],
      });
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) {
        return { status: "UNAVAILABLE", message: "The extraction service's rate limit was reached." };
      }
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
        return { status: "UNAVAILABLE", message: "The extraction service refused the configured credential." };
      }
      if (error instanceof Anthropic.APIConnectionError) {
        return { status: "UNAVAILABLE", message: "The extraction service could not be reached." };
      }
      if (error instanceof Anthropic.APIError) {
        return { status: "FAILED", message: `The extraction service answered ${error.status ?? "with an error"}.` };
      }
      throw error;
    }

    if (response.stop_reason === "refusal") return { status: "FAILED", message: "The extraction service declined this document." };
    if (response.stop_reason === "max_tokens") return { status: "FAILED", message: "The extraction answer was cut off." };
    const block = response.content.find((entry) => entry.type === "text");
    if (!block || block.type !== "text") return { status: "FAILED", message: "The extraction service returned no answer." };

    let raw: unknown;
    try {
      raw = JSON.parse(block.text);
    } catch {
      return { status: "FAILED", message: "The extraction service returned malformed JSON." };
    }
    return {
      status: "OK",
      candidates: readCandidates(raw, request.maxCandidates),
      model: this.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }
}
