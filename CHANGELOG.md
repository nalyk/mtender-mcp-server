# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.3.0] — 2026-05-06

### Security

- **⚠️ BREAKING for silently-insecure deployments — refuse to start on
  insecure HTTP config.** Previously, the entrypoint emitted a
  `logger.warn` and started anyway when `HOST` was a non-localhost
  interface with `MCP_AUTH_MODE=none` and no `ALLOWED_HOSTS`. A warning
  in container logs is the worst kind of insecure-by-default — it scrolls
  past unnoticed and leaves `/mcp` reachable from the network without
  DNS-rebind protection or auth. The entrypoint now hard-fails with an
  explicit error message naming the three remediation paths:
  - set `ALLOWED_HOSTS` to an explicit Host-header allow-list, OR
  - enable `MCP_AUTH_MODE=bearer` (RFC 9068 token gate), OR
  - bind `HOST` to `127.0.0.1`.

  **Operators affected**: anyone running with `HOST=0.0.0.0` (or any
  non-loopback interface) AND `MCP_AUTH_MODE=none` AND no `ALLOWED_HOSTS`
  set. Container deployments via the bundled Dockerfile are the most
  likely impact zone — `HOST=0.0.0.0` is required for container
  reachability and stays the default, so the explicit env opt-in is now
  mandatory. Set `ALLOWED_HOSTS=mcp.example.com` (or your real public
  hostname) on the `docker run` command line, OR enable bearer auth.

  **Operators NOT affected**: stdio-mode deployments, `HOST=127.0.0.1`
  HTTP deployments, and any HTTP deployment that already set one of
  `ALLOWED_HOSTS` / `MCP_AUTH_MODE=bearer`.

  Two subprocess tests in `test/shutdown.test.ts` cover the refusal path
  AND the positive-start path with `ALLOWED_HOSTS` set, so this gate
  cannot regress to either silently insecure OR over-restrictive.

### Changed

- **CI `npm audit` gate raised from `--audit-level=high` to
  `--audit-level=moderate`.** Surfaces transitive moderates in CI logs
  (currently: `ip-address` GHSA-v2v4-37r5-5v8g via SDK ≥ 1.26 →
  express-rate-limit; not exploitable in our usage — no `Address6` HTML
  rendering). Stays `continue-on-error: true` because moderate findings
  should not block PRs while the SDK chain resolves them upstream.

## [3.2.0] — 2026-05-06

### Fixed

- **Streamable HTTP stateless transport reuse bug.** The previous `runHttp`
  created a single `McpServer` + `StreamableHTTPServerTransport` at startup
  and reused them across every request. SDK ≥ 1.26 explicitly forbids this
  in stateless mode (`sessionIdGenerator: undefined`); only the first request
  succeeded, subsequent sequential and concurrent POSTs returned HTTP 500
  with empty body. Extracted the HTTP server into a `src/http.ts:startHttpServer`
  factory that instantiates a fresh `McpServer` + transport per `app.post('/mcp')`
  invocation (matching the SDK's `simpleStatelessStreamableHttp.js` example).
  `app.get('/mcp')` and `app.delete('/mcp')` return JSON-RPC 405 directly —
  in stateless mode there is no SSE stream to attach to and no session to
  terminate.
- **TOCTOU SSRF window in `fetch_tender_document`.** `src/ssrf.ts:52` already
  promised "the caller MUST use the returned `resolvedIp` ... to defeat
  TOCTOU rebind", but the wiring was never done. `fetchDocument` passed the
  URL string to undici, which re-resolved DNS independently. Added
  `pinnedLookup(resolvedIp): LookupFunction` and a per-call
  `Agent({ connect: { lookup } })` so the TCP connect targets the validated
  IP; SNI / TLS cert validation still uses the URL hostname.
- **Upstream `limit` param ignored in MTender listings.** `listFrom` only
  ever appended `offset=`; the four `search_*` tools' `limit` schema field
  was silently truncated to the upstream default page (~100). Threaded
  `ListOpts.limit` through `listTenders`, `listContractNotices`, `listPlans`,
  `listBudgets`. Verified live: `?limit=200` returns 200 items.
- **`server.ts/instructions` claimed "Tools (16):"** while `registerTools`
  actually registered 17 (server.test.ts already encoded the truth).
  Aligned to "Tools (17):".

### Added

- **Optional Bearer-token authorization for HTTP transport (RFC 9068, RFC 8707).**
  Off by default (`MCP_AUTH_MODE=none`). Switch on with `MCP_AUTH_MODE=bearer` +
  `MCP_AUTH_ISSUER` + `MCP_AUTH_AUDIENCE`; optionally `MCP_AUTH_JWKS_URL` and
  `MCP_AUTH_REQUIRED_SCOPES`. `JoseTokenVerifier` enforces issuer + audience
  binding and required scopes; PRM router publishes
  `/.well-known/oauth-protected-resource{path}` per RFC 9728. `/healthz`
  remains open so liveness probes need no credentials.
- **Graceful SIGTERM / SIGINT / uncaught / unhandledRejection shutdown.**
  Idempotent `shutdown(signal, exitCode)` awaits `httpHandle.close()` /
  `stdioServer.close()`, then `process.exit(exitCode)` via 50ms `.unref()`
  timeout for pino flush. Pre-fix the process was killed by signal (exit
  code 143); now exits 0.
- **`logging` capability now actually emits.** `server.sendLoggingMessage`
  was declared in capabilities but never called; wired via a `logEvent`
  helper at four high-signal points: `scanned_pdf_detected` (info),
  `aggregate_by_buyer.complete` / `aggregate_by_supplier.complete` (info),
  `single_bid_scan.complete` (warning).
- **CI `smoke-http` job.** Parallel to `smoke-stdio`, posts two sequential
  `initialize` requests and asserts both 200, GET → 405, SIGTERM → exit 0.
  Pre-fix the HTTP transport-reuse bug would have shipped silently.
- **`/healthz` endpoint** exposed on the HTTP transport for container
  liveness probes — returns `{ ok, name, version }`.

### Changed

- **Refactored `src/tools.ts` (734-line monolith) into `src/tools/<group>.ts`.**
  17 tools split by domain into `search.ts` (5), `tender.ts` (6), `budget.ts`
  (2), `analytics.ts` (3), `document.ts` (1), with shared helpers in
  `_shared.ts` and orchestration in `index.ts`. Behavior byte-for-byte
  identical; the 33-test suite continues to pass with no test changes.
- `fetchDocument` signature: `(url: string, signal)` → `(validated: ValidatedDocUrl, signal)`.
  Internal API only — not exported as a public consumer surface.

### Security

- **TOCTOU SSRF closed** in `fetch_tender_document` (see Fixed above). Was
  in-scope per `SECURITY.md` — finding from architectural re-validation.
- DNS pinning via `Agent({ connect: { lookup: pinnedLookup(resolvedIp) } })`;
  TLS cert validation still requires the legitimate `storage.mtender.gov.md`
  certificate even when the connect IP is pinned.

### Tests

- 20 → 38. New: 7 HTTP transport tests, 5 OAuth gate tests, 3 `pinnedLookup`
  unit tests, 2 subprocess shutdown tests, 1 upstream-limit live test.

## [3.1.1] — 2026-05-02

### Changed

- **npm publish via OIDC trusted publishers (no static token).** Workflow
  triggers on `v*.*.*` tag push, runs on Node 24 (which ships npm ≥ 11.5
  natively — avoids the npm 10.x self-upgrade arborist race),
  authenticates to the npm registry via the GitHub OIDC token. No
  `NPM_TOKEN` secret required after the v3.1.0 bootstrap. Provenance
  attestation auto-generated by npm when publishing via OIDC.
- `package.json`: dropped `./` prefix from `bin` (npm 11+ rejects entries
  with leading `./`); removed `publishConfig.provenance: true` (would break
  any local bootstrap publish because no OIDC env exists locally); added
  `types` entrypoint, `SECURITY.md` to the `files` allow-list.
- `src/server.ts`: `SERVER_VERSION` is now read from `package.json` at
  runtime so `npm version` bumps stay in sync without code edits.
- `tsconfig.json`: enabled `declaration: true` so consumers get type
  definitions alongside the JS.
- README: full rewrite with use-case table, MCP host config examples
  (Claude Desktop / Cursor / Continue / generic HTTP), provenance
  verification instructions, contributing & acknowledgements sections.
  Badges now include trusted-publisher signal, install size, last commit,
  open issues, GitHub stars, and the publish workflow status.

### Added

- `.nvmrc` pinning Node 22 (matches `engines.node` minimum).
- Publish workflow guards: tag↔version drift fails the run; idempotency
  guard skips publish + release-create when the version is already on npm.
- Test that asserts the reported `serverInfo.version` matches
  `package.json` — drift catcher.

## [3.1.0] — 2026-05-01

Initial public release.

### Added

- **Tiered document extraction.** `fetch_tender_document` now detects
  scanned PDFs (Canon / HP / Epson scanner-producer signature, low
  char-per-byte density, absent Romanian diacritics) and returns per-page
  JPEG `image` content blocks for the host's vision LLM to OCR. Handles
  Romanian / Russian / English / mixed text without local OCR
  infrastructure. Native-text PDFs continue to extract via `unpdf`. New
  `mode: auto | text | image` argument lets callers force a strategy.
- **DOCX with tables.** Switched from `mammoth.extractRawText` to
  `mammoth.convertToHtml` + a minimal HTML→Markdown converter that
  preserves GFM tables.
- **Three additional listing endpoints.** `/tenders/cn`, `/tenders/plan`,
  `/budgets` are exposed both as resources (`mtender://contract-notices/latest`,
  `mtender://plans/latest`, `mtender://budgets/latest`) and tools
  (`search_contract_notices`, `search_plans`, `search_budgets`).
- **First-class OCDS structures.** `TenderSummary` now exposes `lots[]`,
  `enquiries[]` (public Q&A), `bidStatistics[]`, `procurementMethodModalities`,
  and `hasElectronicAuction`. New tools `list_lots`, `list_enquiries`,
  `list_bid_statistics`.
- **Aggregations.** `aggregate_by_buyer`, `aggregate_by_supplier`, and
  `flag_single_bid_awards` fan out across the latest N tenders with
  bounded concurrency and emit progress notifications.
- **Procurement-investigation prompts.** `analyze-procurement`,
  `compare-tenders`, `audit-supplier`, `single-bid-investigation`,
  `buyer-spend-overview`, `enquiry-review`, `lot-breakdown`,
  `pipeline-overview`. OCID arguments autocomplete from live data.
- **Upstream observability.** `mtender://upstream/health` surfaces the
  upstream `/actuator/health` + build info.
- **Streamable HTTP transport.** Stateless sessions, DNS-rebinding
  protection via the SDK's host-validation middleware, bound to
  `127.0.0.1` by default.
- **SSRF defense in depth on document fetch.** URL parse →
  exact-hostname allow-list → DNS lookup → reject of RFC1918 / loopback
  / link-local / `169.254.169.254` (AWS/GCP IMDS) / IPv6 ULA.
- **Operational hardening.** `undici` keep-alive Agent (8 sockets),
  per-resource TTL+LRU caches (10 min), bounded fan-out (4-way), retry
  on transient network errors only.
- **20 tests** against live MTender via the SDK's `InMemoryTransport` +
  SSRF guard tests.

### Architecture

- MCP protocol revision **2025-11-25**, SDK **1.29**.
- Node.js 22+ (LTS through 2027-04-30), TypeScript strict, ESM only.
- Distroless multi-stage Docker image, `nonroot` user.
- Compiles a real OCDS record by fanning out to the upstream `packages[]`
  release-package URIs and merging by id-union — fixes the legacy bug
  where `compiledRelease` was sparse and consumers got empty
  `awards[]` / `items[]` / `parties[]` arrays.

[Unreleased]: https://github.com/nalyk/mtender-mcp-server/compare/v3.3.0...HEAD
[3.3.0]: https://github.com/nalyk/mtender-mcp-server/compare/v3.2.0...v3.3.0
[3.2.0]: https://github.com/nalyk/mtender-mcp-server/compare/v3.1.1...v3.2.0
[3.1.1]: https://github.com/nalyk/mtender-mcp-server/compare/v3.1.0...v3.1.1
[3.1.0]: https://github.com/nalyk/mtender-mcp-server/releases/tag/v3.1.0
