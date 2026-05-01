# Contributing

## Quick start

```bash
git clone git@github.com:nalyk/mtender-mcp-server.git
cd mtender-mcp-server
npm install
npm run build
npm test          # 20 tests, hits live public.mtender.gov.md (~30s)
npm run inspector # opens the MCP inspector against the built server
```

Node.js 22+ required (Node 20 reached end-of-life on 2026-04-30).

## Project shape

- `src/server.ts` wires the `McpServer`. Tools live in `src/tools.ts`,
  resources in `src/resources.ts`, prompts in `src/prompts.ts`.
- `src/api/mtender.ts` is the only place that talks to upstream. If
  you need a new endpoint, add it there.
- `src/schemas.ts` is OCDS-aligned Zod. Adding a field to a tool's
  output starts here.
- `src/document.ts` is the tiered PDF / DOCX / TXT extractor. The
  scanned-PDF detection heuristic is documented inline.
- `src/ssrf.ts` is the document-fetch SSRF guard. Treat every layer as
  load-bearing.

## Pull requests

- Run `npm run build && npm test` locally before opening a PR. CI runs
  the same on Node 22 and Node 24.
- Keep the public protocol surface stable — tool names, output schemas,
  and resource URIs are wire contracts. If you must change one, bump
  the minor version in `package.json` and `src/server.ts`, and add a
  CHANGELOG entry under `## [Unreleased]`.
- Prefer small, focused PRs. Refactors and feature work in separate PRs.
- Update the CHANGELOG under `## [Unreleased]` for any user-visible
  change.

## Adding a tool

1. Define input + output Zod schemas in `src/schemas.ts` (or inline if
   strictly local).
2. Register with `server.registerTool(name, { title, description,
   inputSchema, outputSchema, annotations }, handler)` in `src/tools.ts`.
3. Mark `readOnlyHint: true` if the tool has no side effects.
4. If the tool fans out across many upstream calls, route through
   `mapBounded` (concurrency 4) and emit `notifications/progress`.
5. Add a test in `test/server.test.ts` using `InMemoryTransport`. Hit
   live MTender — the test budget is generous enough.

## Adding a resource

1. Pick a stable URI shape under `mtender://`.
2. For OCID-templated resources, reuse the shared `completeOcid`
   completion provider so users get autocomplete.
3. Static "latest" listings should default to a 30-day-back window —
   the upstream API returns the *oldest* records when no offset is
   passed.

## Adding a prompt

Prompts are templated agent instructions. Keep the message text close
to plain English — the agent reads it. OCID arguments should use the
`ocidArg()` helper for autocomplete.

## Style

- TypeScript strict, ESM only. No `any` unless interfacing with the
  upstream's unstructured JSON.
- Logs go to **stderr** via `pino`. Never `console.log` — it would
  corrupt the stdio JSON-RPC stream.
- `await` over `.then()`. Errors propagate; the SDK formats them.
- No emojis in code or prose.

## Reporting vulnerabilities

See [SECURITY.md](./SECURITY.md). Do not open a public issue.
