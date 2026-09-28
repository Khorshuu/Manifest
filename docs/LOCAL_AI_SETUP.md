# Local research and SeoPulse AI — setup

This guide sets up Manifest's free, local product research (D-124). With it,
**Prepare with SeoPulse** can find a product's official page, read it, and draft
content with no paid service and no API key.

- Crawling runs from this PC.
- AI runs on this PC, through Ollama.
- Product pages and product data are processed on this PC. They are not sent to
  Anthropic, Brave, DataForSEO or any other cloud AI or data service.
- Visiting manufacturer pages and running web searches still uses the internet.
  That is how the pages are found and read.

Each part is optional. Manifest starts, and Prepare with SeoPulse works, with
none of them installed. Each part you add widens what preparation can find or
read.

## 1. Settings

Add these lines to `.env.local`, then restart `npm run dev`:

```
PRODUCT_RESEARCH_PROVIDER=local
PRODUCT_EXTRACTION_PROVIDER=ollama
SEO_PULSE_AI_PROVIDER=ollama

OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=

SEARXNG_BASE_URL=http://127.0.0.1:8080

LOCAL_BROWSER_RENDERER=playwright
```

You do not need `ANTHROPIC_API_KEY`, `BRAVE_SEARCH_API_KEY` or the DataForSEO
settings. If they are set, the local providers do not use them.

## 2. Ollama (local AI)

1. Install Ollama for Windows from <https://ollama.com/download>. It runs in the
   background and listens on `http://127.0.0.1:11434`.
2. Download a model that supports structured JSON output. For example, in a
   terminal:

   ```
   ollama pull qwen2.5:7b
   ```

   Any model you have installed works; the name above is an example, not a
   requirement. A 7–8B model needs about 8 GB of free memory. A larger model
   reads more accurately but more slowly.
3. Put the model's name in `.env.local`: `OLLAMA_MODEL=qwen2.5:7b`.
4. Optional: use different models for reading pages and for writing content
   with `OLLAMA_EXTRACTION_MODEL` and `OLLAMA_SEO_MODEL`.

Other Ollama settings, all optional:

| Setting | Default | What it does |
| --- | --- | --- |
| `OLLAMA_TIMEOUT_MS` | `240000` | How long one answer may take. |
| `OLLAMA_NUM_CTX` | `16384` | The model's context window. Larger reads more of a long page and needs more memory. |
| `OLLAMA_ALLOW_REMOTE` | off | Allow an Ollama on another computer. Leave it off unless you mean it: product pages are then sent to that computer. |

Manifest only talks to `127.0.0.1`, `localhost` or `::1` unless
`OLLAMA_ALLOW_REMOTE=true`.

## 3. SearXNG (local web search, optional)

Without SearXNG, Manifest finds pages in the sitemaps of the brand's approved
official domains only. SearXNG adds web-wide search, still with no key.

1. Run SearXNG on this PC. The simplest way is Docker Desktop:

   ```
   docker run -d --name searxng -p 8080:8080 searxng/searxng
   ```

2. Turn on JSON output. In SearXNG's `settings.yml`, under `search:`, make sure
   `formats` includes `json`:

   ```yaml
   search:
     formats:
       - html
       - json
   ```

   Restart SearXNG after the change.
3. Set `SEARXNG_BASE_URL=http://127.0.0.1:8080`.

The setup panel says **SearXNG JSON search disabled** when step 2 is missing.

## 4. Browser rendering (optional)

Some product sites show their content only after JavaScript runs. For those
pages Manifest can use a local Chromium. It is used only when the normal fetch
returns an empty page shell, and every request it makes goes through the same
safety checks as normal fetching.

1. Install the browser: `npx playwright install chromium`
2. Set `LOCAL_BROWSER_RENDERER=playwright`.

## 5. Check the setup

Open **Admin → Intelligence → SeoPulse → Research setup**, or **Advanced tools**
on a product. The panel shows:

| Item | States |
| --- | --- |
| Local web discovery | Ready · Official-domain sitemaps only · SearXNG not running · SearXNG JSON search disabled |
| Local intelligent extraction | Ollama ready — model · Ollama not running · Configured model not installed · No local model chosen |
| SeoPulse content AI | Ollama ready — model · Ollama not running · Rules mode |
| Crawler | Static fetch ready · browser renderer ready / off / not installed |

The panel shows states only, never a key.

## 6. What happens when something is not running

| Not available | What preparation does |
| --- | --- |
| SearXNG | Reads the official-domain sitemaps, the Brand Source Registry and the pages staff attach. The run notes that local web search was unavailable. |
| Approved official domain | Uses SearXNG if it is running. Approving the brand's domain in the Brand Source Registry lets sitemaps find the next product automatically. |
| Browser renderer | Reads the static page, and notes that the page shows little without JavaScript. |
| Ollama (extraction) | Reads tables, specification lists and structured data only. Preparation explains that prose on the page was not read into facts. |
| Ollama (SeoPulse) | Writes content with the rules generator. The run is labelled rule-based; nothing claims AI wrote it. |

Nothing is ever sent to a paid or cloud service as a fallback.

## 7. What stays the same

- A page found by any search is only an address. It is fetched safely, checked
  against the product's identity, and read. A search result's snippet is never
  a product fact.
- Every fact the local model reads must be found word for word, and number for
  number, in the page's own text. Otherwise it is discarded.
- Values still become claims that a person accepts, under the verification
  policies.
- Content written by the local model is filled into fields that are empty or
  still SeoPulse's own, once the product's facts are settled (D-125).
  Staff-written and locked fields are never replaced.

## 8. Live acceptance (Phase B)

After installing Ollama (and, if wanted, SearXNG), prepare a few different
products — for example a beauty product sold by shade, an electronics product
with a specification page, and a food, apparel or skincare product. For each,
check that:

1. the setup panel shows the services as ready;
2. the run finds the official page (or uses the attached one);
3. facts read from prose appear as proposals or claims with the page's excerpt;
4. SeoPulse's content uses only verified facts, and a READY run leaves it in
   the listing's description, key features, SEO title, meta description, tags
   and search terms.

Until this is done, local Ollama and SearXNG operation is **unverified**: the
code is tested against fakes of both services, not against the real ones.
