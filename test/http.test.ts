import { test } from "node:test";
import assert from "node:assert/strict";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { startHttpServer, type HttpServerHandle } from "../src/http.ts";
import { createServer } from "../src/server.ts";

const SERVER_NAME = "mtender-mcp-server";
const SERVER_VERSION = "0.0.0-test";

interface JsonRpcInit {
  jsonrpc: "2.0";
  id: number;
  method: "initialize";
  params: {
    protocolVersion: string;
    capabilities: Record<string, never>;
    clientInfo: { name: string; version: string };
  };
}

const initBody = (id: number): JsonRpcInit => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "http-test", version: "1" },
  },
});

const postHeaders = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
} as const;

async function startTestServer(): Promise<HttpServerHandle> {
  return startHttpServer({
    host: "127.0.0.1",
    port: 0,
    createServer,
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
  });
}

async function withServer<T>(fn: (handle: HttpServerHandle) => Promise<T>): Promise<T> {
  const handle = await startTestServer();
  try {
    return await fn(handle);
  } finally {
    await handle.close();
  }
}

async function postInit(url: string, id: number): Promise<{ status: number; text: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: postHeaders,
      body: JSON.stringify(initBody(id)),
      signal: ctrl.signal,
    });
    const text = await r.text();
    return { status: r.status, text };
  } finally {
    clearTimeout(timer);
  }
}

test("two sequential POST /mcp initialize requests both return 200", async () => {
  await withServer(async ({ url }) => {
    const r1 = await postInit(url, 1);
    assert.equal(r1.status, 200, `first request must succeed; body=${r1.text.slice(0, 200)}`);
    assert.match(r1.text, /protocolVersion/, "first response must carry protocolVersion");

    const r2 = await postInit(url, 2);
    assert.equal(
      r2.status,
      200,
      `second request must also succeed (proves the stateless transport-reuse bug is fixed); body=${r2.text.slice(0, 200)}`,
    );
    assert.match(r2.text, /protocolVersion/, "second response must carry protocolVersion");
  });
});

test("two concurrent POST /mcp initialize requests both return 200", async () => {
  await withServer(async ({ url }) => {
    const [r1, r2] = await Promise.all([postInit(url, 10), postInit(url, 11)]);
    assert.equal(r1.status, 200, `concurrent A must succeed; body=${r1.text.slice(0, 200)}`);
    assert.equal(r2.status, 200, `concurrent B must succeed; body=${r2.text.slice(0, 200)}`);
  });
});

test("GET /mcp returns 405 in stateless mode", async () => {
  await withServer(async ({ url }) => {
    const r = await fetch(url, { method: "GET" });
    assert.equal(r.status, 405);
    const body = (await r.json()) as { jsonrpc: string; error: { code: number; message: string } };
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.error.code, -32000);
    assert.match(body.error.message, /not allowed/i);
  });
});

test("DELETE /mcp returns 405 in stateless mode", async () => {
  await withServer(async ({ url }) => {
    const r = await fetch(url, { method: "DELETE" });
    assert.equal(r.status, 405);
    const body = (await r.json()) as { jsonrpc: string; error: { code: number; message: string } };
    assert.equal(body.error.code, -32000);
  });
});

test("GET /healthz returns ok with name + version", async () => {
  await withServer(async ({ port }) => {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { ok: boolean; name: string; version: string };
    assert.deepEqual(body, { ok: true, name: SERVER_NAME, version: SERVER_VERSION });
  });
});

test("handle.close() releases the port — subsequent requests fail with ECONNREFUSED", async () => {
  const handle = await startTestServer();
  await handle.close();
  await assert.rejects(
    () =>
      fetch(`http://127.0.0.1:${handle.port}/healthz`, {
        signal: AbortSignal.timeout(1000),
      }),
    (err: Error) => /ECONNREFUSED|fetch failed|connect/i.test(String(err.cause ?? err)),
  );
});

test("handle.close() can be called only once without error; subsequent close is a no-op or idempotent", async () => {
  const handle = await startTestServer();
  await handle.close();
  // Double close should not throw a hard error — Node http Server.close() rejects
  // if not listening; this is acceptable as long as it does not crash the process.
  await handle.close().catch(() => undefined);
});

// ──────────────────────────────────────────────────────────────────────────
// Optional Bearer-token authorization (RFC 9068).
// We inject a stub OAuthTokenVerifier via the SDK's `requireBearerAuth` so
// tests don't need a real JWKS server. This proves the WIRING — that
// startHttpServer mounts the middleware on /mcp and not on /healthz, and
// that 401 carries the WWW-Authenticate header per spec.
// ──────────────────────────────────────────────────────────────────────────

const TEST_TOKEN = "test-valid-token";

const stubVerifier: OAuthTokenVerifier = {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (token === TEST_TOKEN) {
      return {
        token,
        clientId: "test-client",
        scopes: ["mcp:read"],
        // SDK's requireBearerAuth rejects tokens without `expiresAt` (it
        // refuses unbounded sessions). 1 hour from now is plenty for tests.
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
    }
    throw new InvalidTokenError("token rejected by stub verifier");
  },
};

const RESOURCE_METADATA_URL = "https://example.test/.well-known/oauth-protected-resource";

async function startAuthedTestServer(): Promise<HttpServerHandle> {
  return startHttpServer({
    host: "127.0.0.1",
    port: 0,
    createServer,
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    requireAuth: requireBearerAuth({
      verifier: stubVerifier,
      requiredScopes: ["mcp:read"],
      resourceMetadataUrl: RESOURCE_METADATA_URL,
    }),
  });
}

test("authed mode: POST /mcp without Authorization returns 401 with WWW-Authenticate", async () => {
  const handle = await startAuthedTestServer();
  try {
    const r = await fetch(handle.url, {
      method: "POST",
      headers: postHeaders,
      body: JSON.stringify(initBody(1)),
    });
    assert.equal(r.status, 401, "unauthenticated POST must be 401");
    const wwwAuth = r.headers.get("WWW-Authenticate") ?? "";
    assert.match(wwwAuth, /Bearer/i, "WWW-Authenticate must advertise Bearer scheme");
    assert.match(
      wwwAuth,
      new RegExp(RESOURCE_METADATA_URL.replace(/\./g, "\\.")),
      "WWW-Authenticate must advertise the resource_metadata URL per RFC 9728",
    );
    await r.body?.cancel();
  } finally {
    await handle.close();
  }
});

test("authed mode: POST /mcp with valid Bearer token returns 200", async () => {
  const handle = await startAuthedTestServer();
  try {
    const r = await fetch(handle.url, {
      method: "POST",
      headers: { ...postHeaders, Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify(initBody(1)),
    });
    assert.equal(r.status, 200, "valid token must yield 200");
    const text = await r.text();
    assert.match(text, /protocolVersion/);
  } finally {
    await handle.close();
  }
});

test("authed mode: POST /mcp with invalid Bearer token returns 401", async () => {
  const handle = await startAuthedTestServer();
  try {
    const r = await fetch(handle.url, {
      method: "POST",
      headers: { ...postHeaders, Authorization: "Bearer wrong-token" },
      body: JSON.stringify(initBody(1)),
    });
    assert.equal(r.status, 401, "rejected token must be 401");
    await r.body?.cancel();
  } finally {
    await handle.close();
  }
});

test("authed mode: GET /healthz remains open (liveness probes have no credentials)", async () => {
  const handle = await startAuthedTestServer();
  try {
    const r = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
    assert.equal(r.status, 200, "healthz must NOT be gated by bearer auth");
    const body = (await r.json()) as { ok: boolean };
    assert.equal(body.ok, true);
  } finally {
    await handle.close();
  }
});

test("authed mode: GET /mcp without Authorization is also 401 (gate covers all methods)", async () => {
  const handle = await startAuthedTestServer();
  try {
    const r = await fetch(handle.url, { method: "GET" });
    assert.equal(r.status, 401);
    await r.body?.cancel();
  } finally {
    await handle.close();
  }
});
