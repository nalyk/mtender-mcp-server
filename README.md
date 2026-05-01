# mtender-mcp-server

Production-grade Model Context Protocol server for Moldova's MTender public
procurement data, modeled on the
[Open Contracting Data Standard 1.1.5](https://standard.open-contracting.org/).

- MCP protocol revision **2025-11-25**
- `@modelcontextprotocol/sdk@1.x` (`McpServer`, structured tool output, tool
  annotations, completions, resource links, progress notifications)
- Dual transport: **stdio** and **Streamable HTTP** (`MCP_TRANSPORT=http`)
- Stateless HTTP sessions, DNS-rebinding host validation, layered SSRF guard
  on document fetches (URL allow-list + DNS resolution with private/IMDS block)
- Bounded-concurrency upstream fanout, retry on transient failures,
  in-memory TTL+LRU caches per resource type
- Node.js **22+**, TypeScript strict, ESM only

## What this server actually does

MTender exposes its data through three listing endpoints (`/tenders/`,
`/tenders/cn`, `/tenders/plan`) and a fan-out package model — the
`/tenders/{ocid}` endpoint returns sparse compiled metadata and a `packages[]`
array of release-package URIs. The actual lots, items, awards, contracts,
parties, enquiries, and amendments live in those individual release packages.
This server fetches every package concurrently, merges them into a single
`TenderSummary` by id-union, and exposes that as resources, tools, and prompts.

The legacy implementation read only the sparse compiledRelease and silently
returned empty arrays for awards / items / parties / lots / enquiries — that
is fixed here and asserted by a regression test.

## Capabilities

### Resources (5 static + 4 templated)

| URI | What |
|---|---|
| `mtender://tenders/latest` | Most recent ~100 procurement notices (last 30 days) |
| `mtender://contract-notices/latest` | Currently tendering (CN releases only) |
| `mtender://plans/latest` | Forward-looking planning records |
| `mtender://budgets/latest` | Recent budget records |
| `mtender://upstream/health` | Live upstream API health + build info |
| `mtender://tenders/{ocid}` | Full compiled OCDS record (template, listable, completable) |
| `mtender://tenders/{ocid}/releases` | Release timeline by tag |
| `mtender://budgets/{ocid}` | Planning budget |
| `mtender://funding/{ocid}` | Funding source |

### Tools (17)

| Tool | Purpose |
|---|---|
| `search_tenders` | Date-paginated /tenders/ list, defaults to last 30 days |
| `search_contract_notices` | Date-paginated /tenders/cn list |
| `search_plans` | Date-paginated /tenders/plan list |
| `search_budgets` | Date-paginated /budgets list |
| `search_tenders_deep` | Multi-field filter (buyer/supplier/CPV/value/status), fan-out scan |
| `get_tender` | Full compiled OCDS record (parties, lots, items, awards, contracts, enquiries, bid stats, modalities) |
| `get_release_history` | Chronological release timeline |
| `list_lots` | Multi-lot tender breakdown |
| `list_enquiries` | Public Q&A (bidder ↔ buyer) on a tender |
| `list_bid_statistics` | Per-lot bid stats (OCDS bids extension) |
| `list_tender_documents` | All document URLs across tender + awards + contracts |
| `get_budget` / `get_funding_source` | Planning data |
| `aggregate_by_buyer` | Rank buyers by total contract value, with progress |
| `aggregate_by_supplier` | Rank suppliers by awarded value + referencing OCIDs |
| `flag_single_bid_awards` | Surface single-supplier awards (limited-competition red flag) |
| `fetch_tender_document` | SSRF-guarded download + tiered extraction: text-native PDF → text; scanned PDF → JPEG page-image content blocks for host vision OCR (any language); DOCX → Markdown with tables |

All read tools are annotated `readOnlyHint: true, idempotentHint: true,
openWorldHint: true`. `fetch_tender_document` is the only non-read-only tool.
Slow aggregating tools emit `notifications/progress` per upstream fetch.

### Prompts (8)

| Prompt | Workflow |
|---|---|
| `analyze-procurement` | End-to-end OCDS analysis of one tender |
| `compare-tenders` | Side-by-side comparison of two procurements |
| `audit-supplier` | Footprint analysis of a named supplier |
| `single-bid-investigation` | Surface limited-competition awards |
| `buyer-spend-overview` | Rank buyers by total spend |
| `enquiry-review` | Analyze public Q&A on a tender |
| `lot-breakdown` | Walk a multi-lot tender lot-by-lot |
| `pipeline-overview` | Plans → contract-notices → contracts pipeline view |

OCID arguments are autocompleted from the live `mtender://tenders/latest` list.

## Run

```bash
npm install
npm run build

# stdio (local MCP host)
node build/index.js

# Streamable HTTP (remote / shared)
MCP_TRANSPORT=http PORT=8787 HOST=127.0.0.1 node build/index.js
```

Dev:

```bash
npm run dev          # tsx watch on src/index.ts
npm run inspector    # the official MCP inspector against build/index.js
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `PORT` | `8787` | HTTP listen port |
| `HOST` | `127.0.0.1` | HTTP bind host. localhost auto-enables DNS-rebinding protection |
| `ALLOWED_HOSTS` | (auto) | CSV host allow-list when binding to non-localhost |
| `LOG_LEVEL` | `info` | pino level |

## Test

```bash
npm test
```

19 tests against the live MTender API (resource read + tool calls + completion
+ aggregation + listings + lots/enquiries) plus the SSRF guard, using the SDK's
`InMemoryTransport` for in-process client/server pairing.

## Docker

```bash
docker build -t mtender-mcp .
docker run --rm -p 8787:8787 mtender-mcp
```

Distroless `gcr.io/distroless/nodejs22-debian12:nonroot`, runs `MCP_TRANSPORT=http` by default.

## Security

- **Streamable HTTP** binds to `127.0.0.1` by default, refuses requests whose
  `Host` header isn't in the allow-list (DNS-rebinding mitigation per MCP
  2025-11-25 security best practices).
- **Document fetch** validates the URL with `new URL()`, asserts
  `hostname === "storage.mtender.gov.md"`, then resolves DNS and rejects any
  RFC1918 / loopback / link-local / `169.254.169.254` (AWS/GCP IMDS) result.
- **Sessions are stateless** (`sessionIdGenerator: undefined`) — there is no
  session ID to hijack. Per spec: "MCP servers MUST NOT use sessions for
  authentication."
- Logs to **stderr**; stdout is reserved for JSON-RPC.
- No bundled secrets; `.env*` in `.gitignore`.

## Document extraction pipeline

`fetch_tender_document` is the only side-effecting tool, and it is tiered for
the realities of Moldovan procurement docs (most are scanned by Canon
multifunctions):

| Document type | Strategy |
|---|---|
| Native-text PDF | `unpdf.extractText` → returns text |
| Scanned PDF (detected by char-density, scanner-producer signature, or absent Romanian diacritics) | `unpdf.extractImages` per page → re-encoded with `sharp` to JPEG (q78) → returned as MCP `image` content blocks. The host's vision-capable LLM does the OCR — language-agnostic, handles Romanian / Russian / English / mixed text without local OCR infra. |
| DOCX | `mammoth.convertToHtml` → minimal HTML→Markdown that preserves tables (GFM) |
| TXT | UTF-8 decode |

The detection heuristic combines: char-per-byte density (`< 0.005` is almost
certainly scanned), known scanner-producer keywords in PDF metadata
(`canon`, `hp scan`, `scanjet`, `scansnap`, `epson`, `xerox`, etc.), and
absence of Romanian diacritics in a long extracted text (signal of a broken
character map). The `mode` argument lets callers force `text` or `image`
explicitly. Page-image cap: 20 pages per call.

## Known upstream limitations (out of our control)

- No server-side text search. `search_tenders_deep` does client-side filter
  after fetching the latest page — the only viable approach.
- No descending pagination. The API is ascending-by-date only; "latest" requires
  passing `offset≈now`, which this server does by default.
- Implementation/transactions section sparse: MTender doesn't track contract
  execution stage in this dataset. Reflected in the resulting `TenderSummary`.
- The upstream is Spring Boot 1.1.1 (build 2022-12-26); we surface its actuator
  health at `mtender://upstream/health` for ops visibility.

## Architecture

```
src/
├── index.ts            # entry: dual-transport (stdio | streamable HTTP)
├── server.ts           # McpServer + capability + instructions
├── tools.ts            # 17 tools with structured I/O + progress
├── resources.ts        # 5 static + 4 templated resources, all completable
├── prompts.ts          # 8 procurement-investigation workflows
├── api/mtender.ts      # undici Pool + retry + multi-package compile + caches + listing endpoints
├── ssrf.ts             # URL parse + DNS lookup + private-IP block
├── document.ts         # unpdf + mammoth extraction (25 MiB cap)
├── cache.ts            # tiny TTL+LRU
├── concurrency.ts      # bounded-parallel fan-out helper
├── schemas.ts          # OCDS-aligned Zod types (lots, enquiries, bids, items, awards, contracts)
└── logger.ts           # pino → fd 2 (stderr)
```

## License

ISC.
