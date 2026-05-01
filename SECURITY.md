# Security policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 3.x     | yes — current |
| < 3.0   | no — pre-1.x SDK era, do not use |

## Reporting a vulnerability

**Do not open a public issue for security-relevant findings.** Use
GitHub's private vulnerability reporting:

- Go to <https://github.com/nalyk/mtender-mcp-server/security/advisories/new>

Or email **dev.ungheni@gmail.com** with:

- A description of the issue and a minimal reproduction
- The commit / version affected
- Suggested fix or mitigation, if you have one

You should receive an acknowledgement within **3 business days** and a
status update within **7 business days**.

## In scope

- SSRF in `fetch_tender_document` (URL parse, hostname allow-list,
  DNS lookup, private/IMDS IP block)
- DNS rebinding on the Streamable HTTP transport (Host header
  validation)
- Session-handling defects (the server is stateless by design — any
  observed session ID equates to a finding)
- Stdio framing issues (anything ever written to stdout that is not a
  valid JSON-RPC message)
- Document parser DoS (oversized inputs, malformed PDFs/DOCX)
- Cache key collisions or cross-tenant leaks (the server is single-tenant
  by design — any cross-context bleed is a finding)
- Dependency vulnerabilities surfaced by `npm audit` or Dependabot

## Out of scope

- Vulnerabilities in `public.mtender.gov.md` itself — report those to
  the MTender operator
- Issues that require a malicious local user with shell access on the
  same machine as a stdio-mode server (the threat model assumes the
  user trusts the host launching the MCP server)
- Vulnerabilities in transitive dependencies of dev-only tooling (`tsx`,
  `typescript`) when not exercised at runtime

## Hardening defaults

The server defaults are deliberately conservative:

- HTTP transport binds to `127.0.0.1` only
- Streamable HTTP sessions are stateless (`sessionIdGenerator: undefined`)
- Document fetches are limited to `https://storage.mtender.gov.md/get/*`
- 25 MiB cap on extracted document size
- Max 20 page-images per `fetch_tender_document` call
- Logs go to stderr; stdout is reserved for JSON-RPC framing
