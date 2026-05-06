# mtender-mcp-server

[![Listed on Yoda Digital Open Source](https://img.shields.io/badge/listed%20on-opensource.yoda.digital-af9568?style=flat-square)](https://opensource.yoda.digital/en/projects/mtender-mcp-server/)
[![CI](https://github.com/nalyk/mtender-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/nalyk/mtender-mcp-server/actions/workflows/ci.yml)
[![CodeQL](https://github.com/nalyk/mtender-mcp-server/actions/workflows/codeql.yml/badge.svg)](https://github.com/nalyk/mtender-mcp-server/actions/workflows/codeql.yml)
[![Publish](https://github.com/nalyk/mtender-mcp-server/actions/workflows/publish.yml/badge.svg)](https://github.com/nalyk/mtender-mcp-server/actions/workflows/publish.yml)
[![npm version](https://img.shields.io/npm/v/mtender-mcp-server.svg?logo=npm&color=cb3837)](https://www.npmjs.com/package/mtender-mcp-server)
[![npm downloads](https://img.shields.io/npm/dm/mtender-mcp-server.svg?color=cb3837)](https://www.npmjs.com/package/mtender-mcp-server)
[![Bundle size](https://img.shields.io/bundlephobia/minzip/mtender-mcp-server?label=install%20size)](https://bundlephobia.com/package/mtender-mcp-server)
[![Trusted publisher](https://img.shields.io/badge/npm-trusted%20publisher-success?logo=sigstore)](https://docs.npmjs.com/trusted-publishers)
[![License: ISC](https://img.shields.io/github/license/nalyk/mtender-mcp-server.svg?color=blue)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg?logo=node.js)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-2025--11--25-purple.svg)](https://modelcontextprotocol.io/specification/2025-11-25)
[![SDK](https://img.shields.io/badge/%40modelcontextprotocol%2Fsdk-1.29-purple.svg)](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
[![OCDS](https://img.shields.io/badge/OCDS-1.1.5-success.svg)](https://standard.open-contracting.org/)
[![GitHub release](https://img.shields.io/github/v/release/nalyk/mtender-mcp-server?include_prereleases&sort=semver&logo=github)](https://github.com/nalyk/mtender-mcp-server/releases)
[![Last commit](https://img.shields.io/github/last-commit/nalyk/mtender-mcp-server?logo=github)](https://github.com/nalyk/mtender-mcp-server/commits/main)
[![Open issues](https://img.shields.io/github/issues/nalyk/mtender-mcp-server?logo=github)](https://github.com/nalyk/mtender-mcp-server/issues)
[![Stars](https://img.shields.io/github/stars/nalyk/mtender-mcp-server?style=social)](https://github.com/nalyk/mtender-mcp-server)

Production-grade Model Context Protocol server for Moldova's MTender public
procurement data, modeled on
[Open Contracting Data Standard 1.1.5](https://standard.open-contracting.org/).

Lets an AI agent (Claude Desktop, Cursor, Continue, custom MCP clients, etc.)
read, search, audit, and summarize **every public procurement** in the
Republic of Moldova from `public.mtender.gov.md`. Tiered document extraction
delegates scanned-PDF OCR to the host's vision LLM — language-agnostic
(Romanian / Russian / English / mixed) without local OCR infrastructure.

---

## Table of contents

- [What you can ask an agent](#what-you-can-ask-an-agent)
- [Install](#install)
- [Use with an MCP host](#use-with-an-mcp-host)
- [Configuration](#configuration)
- [Capabilities](#capabilities)
- [Document extraction](#document-extraction-pipeline)
- [Architecture](#architecture)
- [Security](#security)
- [Releases & provenance](#releases--provenance)
- [Test](#test)
- [Docker](#docker)
- [Known upstream limitations](#known-upstream-limitations)
- [Contributing & support](#contributing--support)
- [License & acknowledgements](#license--acknowledgements)

---

## What you can ask an agent

| Question to the agent | Wired tool / resource |
|---|---|
| "What was tendered last week?" | `mtender://tenders/latest` |
| "What's currently being competed for right now?" | `mtender://contract-notices/latest` |
| "What's planned for procurement next quarter?" | `mtender://plans/latest` |
| "Show me tender ocds-b3wdp1-MD-XXX in full" | `get_tender` |
| "Find all road-construction tenders in the last 30 days" | `search_tenders_deep` with `cpvPrefix=45233` |
| "Find every tender awarded to S.R.L. Foo" | `search_tenders_deep` with `supplierContains=Foo` |
| "Which government body spent the most this month?" | `aggregate_by_buyer` |
| "Who are the top suppliers by total awarded value?" | `aggregate_by_supplier` |
| "Find tenders awarded with only one bidder (red flag)" | `flag_single_bid_awards` |
| "Read the actual PDF attached to this tender" | `fetch_tender_document` (text + vision-OCR fallback) |
| "What did bidders ask publicly, and how did the buyer answer?" | `list_enquiries` |
| "Break this multi-lot tender down lot by lot" | `list_lots` |
| "Show me the timeline — when was it amended?" | `get_release_history` |
| "Compare these two tenders side by side" | prompt `compare-tenders` |
| "Audit this supplier's footprint" | prompt `audit-supplier` |

## Install

From npm (recommended for MCP host configs — no clone, no build):

```bash
# one-shot, no install
npx -y mtender-mcp-server

# or globally
npm install -g mtender-mcp-server
mtender-mcp                                          # stdio
MCP_TRANSPORT=http mtender-mcp                       # Streamable HTTP
```

From source (for contributing):

```bash
git clone git@github.com:nalyk/mtender-mcp-server.git
cd mtender-mcp-server
npm install
npm run build
npm test
```

## Use with an MCP host

### Claude Desktop / Claude Code

Add to your MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "mtender": {
      "command": "npx",
      "args": ["-y", "mtender-mcp-server"]
    }
  }
}
```

### Cursor / Continue / Cline

Same shape — most MCP-aware editors support stdio servers via the same
`command + args` JSON config.

### Generic Streamable HTTP host

Run it once as a service, point the host at the URL:

```bash
MCP_TRANSPORT=http PORT=8787 HOST=127.0.0.1 npx -y mtender-mcp-server
# host config: { "url": "http://127.0.0.1:8787/mcp" }
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `PORT` | `8787` | HTTP listen port |
| `HOST` | `127.0.0.1` | HTTP bind host. localhost auto-enables DNS-rebinding protection |
| `ALLOWED_HOSTS` | (auto) | Comma-separated host allow-list when binding to non-localhost |
| `LOG_LEVEL` | `info` | pino level — `trace` `debug` `info` `warn` `error` `fatal` |
| `MCP_AUTH_MODE` | `none` | `none` or `bearer` (RFC 9068 OAuth 2.1 Bearer token gate on `/mcp`) |
| `MCP_AUTH_ISSUER` | — | Required when `MCP_AUTH_MODE=bearer`. URL of the Authorization Server. |
| `MCP_AUTH_AUDIENCE` | — | Required when `MCP_AUTH_MODE=bearer`. Token audience (RFC 8707) — typically `https://your-host.example/mcp`. |
| `MCP_AUTH_JWKS_URL` | (auto) | Override of the discovered `jwks_uri`. Auto-discovered from `<issuer>/.well-known/oauth-authorization-server` (or `/openid-configuration`) when unset. |
| `MCP_AUTH_REQUIRED_SCOPES` | — | Comma- or space-separated scopes the token must carry, e.g. `mcp:read`. Empty = no scope check (still authenticates). |

When `MCP_AUTH_MODE=bearer` is on, the server also publishes RFC 9728
Protected Resource Metadata at `/.well-known/oauth-protected-resource{path}`
so unauthenticated clients can discover the AS to obtain a token from. The
`/healthz` endpoint stays public (liveness probes have no credentials).
Refusing without `bearer` while bound to a non-localhost interface emits a
warning — defense in depth for accidental public exposure.

## Capabilities

### Resources (5 static + 4 OCID-templated)

| URI | Notes |
|---|---|
| `mtender://tenders/latest` | Most recent ~100 procurement notices (last 30 days) |
| `mtender://contract-notices/latest` | Currently tendering (CN releases only) |
| `mtender://plans/latest` | Forward-looking planning records |
| `mtender://budgets/latest` | Recent budgets |
| `mtender://upstream/health` | Live upstream API health + build info |
| `mtender://tenders/{ocid}` | Full compiled OCDS record (parties, lots, items+CPV, documents, awards, contracts, enquiries, bid stats); listable + completable |
| `mtender://tenders/{ocid}/releases` | Release timeline by tag |
| `mtender://budgets/{ocid}` | Planning budget |
| `mtender://funding/{ocid}` | Funding source |

All `{ocid}` templates support typeahead completion from the live latest list.

### Tools (17)

| Tool | Returns |
|---|---|
| `search_tenders` | `{items, count, nextOffset}` + resource_link per result |
| `search_contract_notices` / `search_plans` / `search_budgets` | Same shape, scoped to each upstream listing endpoint |
| `search_tenders_deep` | Filter by buyer/supplier/CPV/value/status (slow, fan-out, with progress) |
| `get_tender` | Full compiled OCDS summary |
| `get_release_history` | Chronological releases with tags |
| `list_lots` | Multi-lot breakdown |
| `list_enquiries` | Public Q&A (bidder ↔ buyer) |
| `list_bid_statistics` | OCDS bids extension stats |
| `list_tender_documents` | All doc URLs across tender + awards + contracts |
| `get_budget` / `get_funding_source` | Planning data |
| `aggregate_by_buyer` | Buyers ranked by total contract value |
| `aggregate_by_supplier` | Suppliers ranked by awards count + value |
| `flag_single_bid_awards` | Limited-competition red-flag scan |
| `fetch_tender_document` | SSRF-guarded PDF/DOCX/text extraction with vision-OCR fallback |

All read tools annotate `readOnlyHint: true, idempotentHint: true,
openWorldHint: true`. Slow tools emit `notifications/progress`. Every fetch
honors `AbortSignal` for cancellation.

### Prompts (8)

| Prompt | Workflow |
|---|---|
| `analyze-procurement` | End-to-end OCDS analysis of one tender |
| `compare-tenders` | Side-by-side of two tenders (suspect duplicates / coordinated bids) |
| `audit-supplier` | Recent footprint of a named supplier (top buyers, dominant CPV, single-bid count) |
| `single-bid-investigation` | Surface limited-competition awards, group by buyer-supplier pair |
| `buyer-spend-overview` | Top buyers by spend with drill-down |
| `enquiry-review` | Analyze public Q&A on a tender |
| `lot-breakdown` | Walk a multi-lot tender lot-by-lot |
| `pipeline-overview` | Plans → contract notices → contracts pipeline view |

OCID arguments are autocompleted from the live `mtender://tenders/latest` list.

## Document extraction pipeline

`fetch_tender_document` is tiered for the realities of Moldovan procurement
docs (most are scanned by Canon multi-functions):

| Document type | Strategy |
|---|---|
| Native-text PDF | `unpdf.extractText` → text |
| Scanned PDF (detected via char-density, scanner-producer signature, or absent Romanian diacritics) | `unpdf.extractImages` per page → re-encoded with `sharp` to JPEG (q78) → returned as MCP `image` content blocks. **Host's vision LLM does the OCR — language-agnostic, handles Romanian / Russian / English / mixed without local OCR infra.** |
| DOCX | `mammoth.convertToHtml` → minimal HTML→Markdown that preserves GFM tables |
| TXT | UTF-8 decode |

Detection combines: char-per-byte density (`< 0.005` is almost certainly
scanned), scanner-producer keywords in PDF metadata (`canon`, `hp scan`,
`scanjet`, `scansnap`, `epson`, `xerox`, `kyocera`, `ricoh`, `brother`,
`konica`, `lexmark`, `gimp`, `imagemagick`, `tiff`, `kodak`), and absent
Romanian diacritics in long extracted text. The `mode: auto | text | image`
argument lets callers force a strategy. Page-image cap: 20 pages per call.
Document size cap: 25 MiB.

## Architecture

```
src/
├── index.ts            entry: dual-transport (stdio | streamable HTTP)
├── server.ts           McpServer + capabilities + instructions
├── tools.ts            17 tools with structured I/O + progress
├── resources.ts        5 static + 4 templated resources, all completable
├── prompts.ts          8 procurement-investigation workflows
├── api/mtender.ts      undici keep-alive client, retry, multi-package
│                       compile, TTL+LRU caches, listing endpoints
├── ssrf.ts             URL parse + DNS lookup + private-IP block
├── document.ts         unpdf + mammoth + sharp tiered extraction
├── cache.ts            tiny TTL+LRU
├── concurrency.ts      bounded fan-out helper
├── schemas.ts          OCDS-aligned Zod types
└── logger.ts           pino → fd 2 (stderr)
```

- MCP protocol revision **2025-11-25**, SDK `@modelcontextprotocol/sdk@1.29`
- Node.js **22+**, TypeScript strict, ESM only
- 6 runtime deps + `express` for the HTTP transport. Distroless multi-stage
  Docker image (`gcr.io/distroless/nodejs22-debian12:nonroot`)
- Compiles a real OCDS record by fanning out to upstream `packages[]` URIs
  and merging by id-union — `compiledRelease` from MTender is sparse, so
  awards/items/parties have to be reassembled

## Security

- **Streamable HTTP** binds to `127.0.0.1` by default and refuses requests
  whose `Host` header isn't in the allow-list (DNS-rebinding mitigation per
  the MCP 2025-11-25 [security best practices](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices))
- **Document fetch** validates URL with `new URL()`, asserts
  `hostname === "storage.mtender.gov.md"`, then resolves DNS and rejects
  any RFC1918 / loopback / link-local / `169.254.169.254` (AWS/GCP IMDS) /
  IPv6 ULA result before issuing the actual request
- **Stateless sessions** (`sessionIdGenerator: undefined`) — no session ID
  to hijack. Per spec: "MCP servers MUST NOT use sessions for authentication."
- **Logs to stderr**; stdout is reserved for JSON-RPC
- **CodeQL** (`security-and-quality` query suite) runs on every push and PR
- **Dependabot** weekly + on-CVE auto-PRs
- **No bundled secrets**; `.env*` in `.gitignore`

For vulnerability reports see [SECURITY.md](./SECURITY.md). Use GitHub's
private advisory form, not public issues.

## Releases & provenance

This package is published to npm via [trusted publishers](https://docs.npmjs.com/trusted-publishers)
— GitHub Actions authenticates to the npm registry directly via OIDC, no
static `NPM_TOKEN` secret. Every release after the v3.1.0 bootstrap is
attested with [Sigstore provenance](https://docs.npmjs.com/generating-provenance-statements)
proving the tarball was built in this GitHub workflow from this commit.

Verify the chain locally:

```bash
npm view mtender-mcp-server versions --json
npm view mtender-mcp-server@latest dist.attestations
npm audit signatures            # in any project that depends on it
```

Release flow (one command):

```bash
npm version patch -m "Release v%s"        # bumps + commits + tags
git push origin main --follow-tags         # triggers OIDC publish + GitHub release
```

The publish workflow has built-in guards: tag↔version drift fails the run;
re-running on an already-published version skips the publish + release-create
steps idempotently.

## Test

```bash
npm test
```

20 tests against the live MTender API (resource read + tool calls +
completion + aggregation + listings + lots/enquiries + scanned-PDF detection
regression) plus the SSRF guard, using the SDK's `InMemoryTransport` for
in-process client/server pairing. Runs in ~30 seconds.

## Docker

```bash
docker build -t mtender-mcp .
docker run --rm -p 8787:8787 mtender-mcp
```

Distroless `gcr.io/distroless/nodejs22-debian12:nonroot`, runs
`MCP_TRANSPORT=http` by default. The CI pipeline rebuilds the image on
every push to confirm it still bakes cleanly.

## Known upstream limitations

These are out of our control — MTender publishes what MTender publishes:

- **No server-side text search.** Upstream `/tenders/` accepts only `offset`.
  `search_tenders_deep` does client-side filter after fetching the latest
  page — the only viable approach.
- **No descending pagination.** The API is ascending-by-date only; "latest"
  requires passing `offset≈now`, which this server does by default.
- **Implementation/transactions section sparse.** MTender doesn't track
  contract execution stage in this dataset. Reflected in `TenderSummary`.
- **Romanian-only content.** No English / Russian translations of fields.

Upstream Spring Boot version + status is surfaced at
`mtender://upstream/health` for ops visibility.

## Contributing & support

- [CONTRIBUTING.md](./CONTRIBUTING.md) — project shape, contribution norms,
  how to add a tool / resource / prompt
- [CHANGELOG.md](./CHANGELOG.md) — Keep-a-Changelog entries per version
- [SECURITY.md](./SECURITY.md) — private vulnerability reporting + scoped
  threat model
- [Issues](https://github.com/nalyk/mtender-mcp-server/issues) — bug reports
  and feature requests use structured templates
- [Discussions](https://github.com/nalyk/mtender-mcp-server/discussions) —
  questions, design conversations

## License & acknowledgements

[ISC](./LICENSE) © Ion (Nalyk) Calmîș.

Built on:
- [Model Context Protocol](https://modelcontextprotocol.io/) and the
  [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
  by Anthropic + the MCP community
- [Open Contracting Data Standard](https://standard.open-contracting.org/) 1.1.5
- [public.mtender.gov.md](https://public.mtender.gov.md/) — Moldova's
  e-Procurement public data point
- [unpdf](https://github.com/unjs/unpdf), [mammoth](https://github.com/mwilliamson/mammoth.js),
  [sharp](https://sharp.pixelplumbing.com/), [undici](https://undici.nodejs.org/),
  [pino](https://getpino.io/), [zod](https://zod.dev/)
