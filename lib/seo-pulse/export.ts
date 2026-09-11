import { INTENT_LABELS, type KeywordRecommendation } from "./types";
import type { RunDetail } from "./service";
import { escapeHtml } from "./text";

/**
 * The downloadable research: JSON (everything), CSV (one row per finding,
 * for a spreadsheet) and a readable HTML report. All three are built from the
 * stored run only — nothing is recomputed or filled in at export time, so a
 * download says exactly what the run found.
 *
 * Every CSV row carries a `data_type`: "research" for what a source returned,
 * "analysis" for what SEO Pulse recommends. The two are never mixed in a row.
 */

export function exportJson(run: RunDetail, productTitle: string): string {
  return JSON.stringify(
    {
      seoPulseVersion: run.pulseVersion,
      exportedAt: new Date().toISOString(),
      run: {
        id: run.id,
        version: run.version,
        status: run.status,
        researchedAt: run.completedAt ?? run.createdAt,
        initiatedBy: run.initiatedBy,
        appliedAt: run.appliedAt,
        appliedFields: run.appliedFields,
      },
      product: {
        id: run.productId,
        name: productTitle,
        sku: run.inputSnapshot.sku,
      },
      notice:
        "research = data returned by a source, with source and date. analysis = SEO Pulse recommendations. Scores measure this listing's completeness, not a Google ranking.",
      providers: run.providerUsage,
      inputSnapshot: run.inputSnapshot,
      research: run.research,
      analysis: run.analysis,
    },
    null,
    2,
  );
}

const CSV_COLUMNS = [
  "section",
  "item",
  "value",
  "intent",
  "search_volume",
  "difficulty",
  "competition",
  "cpc_usd",
  "trend",
  "source",
  "data_type",
  "confidence",
  "researched_at",
  "note",
] as const;

type CsvRow = Partial<Record<(typeof CSV_COLUMNS)[number], string | number | null>>;

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  // A leading =, +, - or @ is a formula in a spreadsheet; neutralise it.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function exportCsv(run: RunDetail, productTitle: string): string {
  const rows: CsvRow[] = [];
  const at = run.completedAt ?? run.createdAt;
  const analysis = run.analysis;
  const research = run.research;
  const generator = analysis?.generator.label ?? "";
  const confidence = analysis?.generator.kind === "ai" ? "AI-generated" : "Rule-based";
  const rec = (row: CsvRow): CsvRow => ({
    data_type: "analysis",
    source: generator,
    confidence,
    researched_at: at,
    ...row,
  });

  rows.push(rec({ section: "product", item: "name", value: productTitle, data_type: "input", source: "product record", confidence: "direct" }));
  rows.push(rec({ section: "product", item: "id", value: run.productId, data_type: "input", source: "product record", confidence: "direct" }));
  rows.push(rec({ section: "product", item: "sku", value: run.inputSnapshot.sku, data_type: "input", source: "product record", confidence: "direct" }));

  if (analysis) {
    const keywordRow = (section: string, keyword: KeywordRecommendation) => {
      const metric = research?.keywordMetrics.find(
        (entry) => entry.keyword.toLowerCase() === keyword.keyword.toLowerCase(),
      );
      rows.push(
        rec({
          section,
          item: keyword.relevance,
          value: keyword.keyword,
          intent: INTENT_LABELS[keyword.intent],
          search_volume: metric?.searchVolume ?? "unavailable",
          difficulty: metric?.difficulty ?? "unavailable",
          competition: metric?.competition ?? "unavailable",
          cpc_usd: metric?.cpcUsd ?? "unavailable",
          note: metric ? `${keyword.reason} | metrics: ${metric.source}` : keyword.reason,
        }),
      );
    };
    keywordRow("primary_keyword", analysis.primaryKeyword);
    analysis.secondaryKeywords.forEach((keyword) => keywordRow("secondary_keyword", keyword));
    analysis.longTailKeywords.forEach((keyword) => keywordRow("long_tail_keyword", keyword));

    const list = (section: string, values: string[]) =>
      values.forEach((value) => rows.push(rec({ section, value })));
    list("synonym", analysis.synonyms);
    list("related_term", analysis.relatedTerms);
    list("search_alias", analysis.searchAliases);
    analysis.misspellings.forEach((entry) => rows.push(rec({ section: "misspelling", value: entry.term, note: entry.basis })));
    list("search_phrase", analysis.searchPhrases);
    list("brand_variation", analysis.brandVariations);
    list("tag", analysis.tags);
    list("key_feature", analysis.keyFeatures ?? []);

    rows.push(rec({ section: "seo_title", item: "recommended", value: analysis.seoTitle.recommended, note: analysis.seoTitle.reason }));
    analysis.seoTitle.alternatives.forEach((value) => rows.push(rec({ section: "seo_title", item: "alternative", value })));
    rows.push(rec({ section: "meta_description", item: "recommended", value: analysis.metaDescription.recommended, note: analysis.metaDescription.reason }));
    rows.push(rec({ section: "slug", item: "recommended", value: analysis.slug.recommended, note: analysis.slugConflict ? "Conflicts with another product's address." : analysis.slug.reason }));
    rows.push(rec({ section: "h1", item: "recommended", value: analysis.h1.recommended, note: analysis.h1.reason }));
    analysis.description.improvements.forEach((value) => rows.push(rec({ section: "description_improvement", value })));
    if (analysis.description.suggestedHtml) {
      rows.push(rec({ section: "description_suggested", value: analysis.description.suggestedHtml }));
    }
    analysis.contentGaps.forEach((gap) => rows.push(rec({ section: "content_gap", item: gap.label, value: gap.reason, confidence: "fact" })));
    analysis.faqs.forEach((faq) =>
      rows.push(rec({ section: "faq", item: faq.question, value: faq.answer ?? "", note: faq.needsManualAnswer ? `Needs a manual answer. ${faq.basis}` : faq.basis })),
    );
    analysis.imageAlts.forEach((image) => {
      const filename = analysis.imageFilenames.find((entry) => entry.imageId === image.imageId)?.filename;
      rows.push(rec({ section: "image_alt", item: image.imageId, value: image.altText, note: `${image.needsReview ? "Needs review. " : ""}${filename ? `Filename: ${filename}. ` : ""}${image.reason}` }));
    });
    analysis.identifiers.forEach((entry) => rows.push(rec({ section: "identifier", item: entry.label, value: entry.value ?? "unavailable", confidence: "fact" })));
    analysis.schemaReadiness.forEach((entry) => rows.push(rec({ section: "schema", item: entry.field, value: entry.status, note: entry.note, confidence: "fact" })));
    analysis.categoryNotes.forEach((value) => rows.push(rec({ section: "category", value })));
    analysis.competitorObservations.forEach((entry) => rows.push(rec({ section: "competitor_observation", value: entry.observation, note: entry.basis, confidence: "derived from research" })));
    rows.push(rec({ section: "score", item: "SEO Pulse Optimization Score", value: analysis.scores.seo.score, confidence: "fact", note: "Listing completeness, not a Google ranking." }));
    rows.push(rec({ section: "score", item: "Internal Search Score", value: analysis.scores.search.score, confidence: "fact" }));
  }

  if (research) {
    for (const metric of research.keywordMetrics) {
      rows.push({
        section: "keyword_metric",
        value: metric.keyword,
        search_volume: metric.searchVolume ?? "unavailable",
        difficulty: metric.difficulty ?? "unavailable",
        competition: metric.competition ?? "unavailable",
        cpc_usd: metric.cpcUsd ?? "unavailable",
        trend: metric.trend?.map((point) => `${point.month}:${point.volume}`).join(" ") ?? "unavailable",
        source: metric.source,
        data_type: "research",
        confidence: "direct source data",
        researched_at: metric.researchedAt,
        note: metric.geo,
      });
    }
    for (const snapshot of research.serp) {
      for (const result of snapshot.results) {
        rows.push({
          section: "serp_result",
          item: `${snapshot.keyword} #${result.position}`,
          value: result.title,
          source: snapshot.source,
          data_type: "research",
          confidence: "direct source data",
          researched_at: snapshot.researchedAt,
          note: result.url,
        });
      }
      snapshot.relatedSearches.forEach((value) => rows.push({ section: "related_search", value, source: snapshot.source, data_type: "research", confidence: "direct source data", researched_at: snapshot.researchedAt }));
      snapshot.peopleAlsoAsk.forEach((value) => rows.push({ section: "people_also_ask", value, source: snapshot.source, data_type: "research", confidence: "direct source data", researched_at: snapshot.researchedAt }));
    }
    const site = research.siteSearch;
    if (site) {
      site.matchingQueries.forEach((query) =>
        rows.push({ section: "site_search_query", value: query.query, search_volume: query.searches, source: site.source, data_type: "research", confidence: "direct source data", researched_at: site.researchedAt, note: `${query.zeroResultSearches} found nothing; last ${site.windowDays} days` }),
      );
      site.queriesLeadingHere.forEach((query) =>
        rows.push({ section: "site_search_click", value: query.query, search_volume: query.clicks, source: site.source, data_type: "research", confidence: "direct source data", researched_at: site.researchedAt, note: "clicks through to this product" }),
      );
    }
  }

  run.providerUsage.forEach((entry) =>
    rows.push({ section: "provider", item: entry.label, value: entry.status, source: entry.kind, data_type: "meta", researched_at: entry.at, note: [entry.message, entry.estimatedCostUsd !== null ? `cost ~$${entry.estimatedCostUsd.toFixed(4)}` : null].filter(Boolean).join(" ") }),
  );

  return [
    CSV_COLUMNS.join(","),
    ...rows.map((row) => CSV_COLUMNS.map((column) => csvCell(row[column])).join(",")),
  ].join("\r\n");
}

export function exportHtml(run: RunDetail, productTitle: string): string {
  const e = (value: unknown) => escapeHtml(value === null || value === undefined ? "" : String(value));
  const a = run.analysis;
  const r = run.research;
  const list = (items: string[]) =>
    items.length ? `<ul>${items.map((item) => `<li>${e(item)}</li>`).join("")}</ul>` : "<p class=muted>None.</p>";
  const keywordTable = (keywords: KeywordRecommendation[]) =>
    `<table><tr><th>Keyword</th><th>Intent</th><th>Relevance</th><th>Search volume</th><th>Why</th></tr>${keywords
      .map((keyword) => {
        const metric = r?.keywordMetrics.find((entry) => entry.keyword.toLowerCase() === keyword.keyword.toLowerCase());
        return `<tr><td>${e(keyword.keyword)}</td><td>${e(INTENT_LABELS[keyword.intent])}</td><td>${e(keyword.relevance)}</td><td>${metric?.searchVolume != null ? `${e(metric.searchVolume)} <span class=muted>(${e(metric.source)})</span>` : "<span class=muted>Data unavailable</span>"}</td><td>${e(keyword.reason)}</td></tr>`;
      })
      .join("")}</table>`;

  const body = a
    ? `
<p class=label>${e(a.generator.label)}</p>
<h2>Scores</h2>
<p><strong>SEO Pulse Optimization Score:</strong> ${e(a.scores.seo.score)}/100 &middot; <strong>Internal Search Score:</strong> ${e(a.scores.search.score)}/100</p>
<p class=muted>These measure how complete this listing is. They are not Google ranking scores and do not predict ranking.</p>
<h2>Keywords</h2>
${keywordTable([a.primaryKeyword, ...a.secondaryKeywords, ...a.longTailKeywords])}
<h2>SEO recommendations</h2>
<table>
<tr><th>SEO title</th><td>${e(a.seoTitle.recommended)}<br><span class=muted>${e(a.seoTitle.reason)}</span></td></tr>
<tr><th>Alternatives</th><td>${a.seoTitle.alternatives.map(e).join("<br>")}</td></tr>
<tr><th>Meta description</th><td>${e(a.metaDescription.recommended)}</td></tr>
<tr><th>Slug</th><td>/products/${e(a.slug.recommended)}${a.slugConflict ? " <strong>(conflicts with another product)</strong>" : ""}</td></tr>
<tr><th>H1</th><td>${e(a.h1.recommended)}</td></tr>
<tr><th>Tags</th><td>${e(a.tags.join(", "))}</td></tr>
</table>
<h2>Internal search</h2>
<h3>Search aliases</h3>${list(a.searchAliases)}
<h3>Synonyms</h3>${list(a.synonyms)}
<h3>Related terms</h3>${list(a.relatedTerms)}
<h3>Misspellings</h3>${list(a.misspellings.map((entry) => `${entry.term} — ${entry.basis}`))}
<h3>Search phrases</h3>${list(a.searchPhrases)}
<h3>Brand variations</h3>${list(a.brandVariations)}
<h2>Content opportunities</h2>${list(a.contentGaps.map((gap) => `${gap.label}: ${gap.reason}`))}
<h3>Description improvements</h3>${list(a.description.improvements)}
<h3>FAQ opportunities</h3>${list(a.faqs.map((faq) => `${faq.question} — ${faq.answer ?? "Needs a manual answer."}`))}
<h2>Images</h2>
<table><tr><th>Image</th><th>Alt text</th><th>Filename</th><th>Note</th></tr>${a.imageAlts
      .map((image) => `<tr><td>${e(image.imageId.slice(0, 8))}</td><td>${e(image.altText)}</td><td>${e(a.imageFilenames.find((entry) => entry.imageId === image.imageId)?.filename)}</td><td>${image.needsReview ? "<strong>Needs review.</strong> " : ""}${e(image.reason)}</td></tr>`)
      .join("")}</table>
<h2>Identifiers and structured data</h2>
<table>${a.identifiers.map((entry) => `<tr><th>${e(entry.label)}</th><td>${entry.value ? e(entry.value) : "<span class=muted>Unavailable</span>"}</td></tr>`).join("")}</table>
<table>${a.schemaReadiness.map((entry) => `<tr><th>${e(entry.field)}</th><td>${e(entry.status)}</td><td>${e(entry.note)}</td></tr>`).join("")}</table>
<h2>Competitor observations</h2>${list(a.competitorObservations.map((entry) => `${entry.observation} (${entry.basis})`))}`
    : `<p>This run has no analysis. ${e(run.error)}</p>`;

  const research = r
    ? `
<h2>Research data</h2>
<p class=muted>Collected from sources, not generated.</p>
${r.keywordMetrics.length ? `<table><tr><th>Keyword</th><th>Volume</th><th>Difficulty</th><th>Competition</th><th>CPC (USD)</th><th>Source</th></tr>${r.keywordMetrics.map((m) => `<tr><td>${e(m.keyword)}</td><td>${e(m.searchVolume ?? "Unavailable")}</td><td>${e(m.difficulty ?? "Unavailable")}</td><td>${e(m.competition ?? "Unavailable")}</td><td>${e(m.cpcUsd ?? "Unavailable")}</td><td>${e(m.source)}, ${e(m.researchedAt.slice(0, 10))}</td></tr>`).join("")}</table>` : "<p>External keyword metrics: <strong>Data unavailable</strong>.</p>"}
${r.serp.length ? r.serp.map((s) => `<h3>Search results for "${e(s.keyword)}" (${e(s.source)})</h3><ol>${s.results.map((x) => `<li>${e(x.title)} — ${e(x.domain)}</li>`).join("")}</ol>`).join("") : "<p>Search results: <strong>Data unavailable</strong>.</p>"}
${r.siteSearch ? `<h3>${e(r.siteSearch.source)}, last ${e(r.siteSearch.windowDays)} days</h3>${list(r.siteSearch.matchingQueries.map((q) => `${q.query} — ${q.searches} searches, ${q.zeroResultSearches} found nothing`))}` : ""}`
    : "";

  const providers = `<h2>Sources and providers</h2><table><tr><th>Provider</th><th>Status</th><th>Detail</th></tr>${run.providerUsage
    .map((entry) => `<tr><td>${e(entry.label)}</td><td>${e(entry.status)}</td><td>${e(entry.message)}</td></tr>`)
    .join("")}</table>`;

  return `<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width, initial-scale=1"><title>SEO Pulse — ${e(productTitle)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;color:#10213a;max-width:960px;margin:0 auto;padding:24px 16px}h1{font-size:24px}h2{font-size:18px;margin-top:32px;border-top:1px solid #c9d8f0;padding-top:16px}h3{font-size:15px}table{border-collapse:collapse;width:100%;margin:8px 0;display:block;overflow-x:auto}th,td{border:1px solid #c9d8f0;padding:6px 8px;text-align:left;vertical-align:top}.muted{color:#5a6a82}.label{display:inline-block;border:1px solid #b08a3e;padding:2px 8px}</style></head><body>
<h1>SEO Pulse research — ${e(productTitle)}</h1>
<p>Research completed: ${e(run.completedAt ?? run.createdAt)} &middot; Version ${e(run.version)} &middot; SEO Pulse ${e(run.pulseVersion)} &middot; SKU ${e(run.inputSnapshot.sku ?? "—")}</p>
${body}${research}${providers}
</body></html>`;
}
