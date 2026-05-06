#!/usr/bin/env node
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { startHttpServer, type HttpServerHandle } from "./http.js";
import { buildAuthHandles, type AuthConfig } from "./http/auth.js";
import { logger } from "./logger.js";

let httpHandle: HttpServerHandle | null = null;
let stdioServer: McpServer | null = null;
let shuttingDown = false;

async function runStdio(): Promise<void> {
  stdioServer = createServer();
  const transport = new StdioServerTransport();
  await stdioServer.connect(transport);
  logger.info({ name: SERVER_NAME, version: SERVER_VERSION }, "stdio transport ready");
}

async function runHttp(): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "127.0.0.1";
  const allowedHostsEnv = process.env.ALLOWED_HOSTS;
  const allowedHosts = allowedHostsEnv?.split(",").map((s) => s.trim()).filter(Boolean);

  // Optional OAuth 2.1 Bearer-token gate (RFC 9068 + RFC 8707).
  // Default: MCP_AUTH_MODE=none → no auth (suitable for HOST=127.0.0.1).
  // Production deployments on a non-localhost interface should set MCP_AUTH_MODE=bearer
  // and provide the issuer/audience/scopes the deployment expects.
  const mode = (process.env.MCP_AUTH_MODE ?? "none").toLowerCase();
  let auth: { requireAuth?: import("express").RequestHandler; metadataRouter?: import("express").RequestHandler } = {};
  if (mode === "bearer") {
    const issuer = process.env.MCP_AUTH_ISSUER;
    const audience = process.env.MCP_AUTH_AUDIENCE;
    if (!issuer || !audience) {
      throw new Error(
        "MCP_AUTH_MODE=bearer requires MCP_AUTH_ISSUER and MCP_AUTH_AUDIENCE",
      );
    }
    const cfg: AuthConfig = {
      issuer,
      audience,
      jwksUrl: process.env.MCP_AUTH_JWKS_URL,
      requiredScopes: (process.env.MCP_AUTH_REQUIRED_SCOPES ?? "")
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    };
    const handles = await buildAuthHandles(cfg);
    auth = { requireAuth: handles.requireAuth, metadataRouter: handles.metadataRouter };
  } else if (mode !== "none") {
    throw new Error(`Unknown MCP_AUTH_MODE: ${mode}. Expected "none" or "bearer".`);
  } else if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    // Sprint-4 hardening: refuse to start a public-bound HTTP transport that
    // has neither a host allow-list (DNS-rebind protection) nor a bearer
    // gate (auth). A silent warn was the previous behavior — too easy to
    // miss in container logs. Hard-failure forces the operator to make an
    // explicit security decision before /mcp is reachable from off-host.
    if (!allowedHosts || allowedHosts.length === 0) {
      throw new Error(
        `Refusing to start: HOST="${host}" is non-localhost, MCP_AUTH_MODE=none, ` +
          `and ALLOWED_HOSTS is not set. This would expose /mcp without ` +
          `DNS-rebind protection or auth. Set ALLOWED_HOSTS to an explicit ` +
          `list, enable MCP_AUTH_MODE=bearer, or bind HOST to 127.0.0.1.`,
      );
    }
    logger.warn(
      { host, allowedHosts },
      "MCP_AUTH_MODE=none on non-localhost HOST — relying on Host-header allow-list for protection.",
    );
  }

  httpHandle = await startHttpServer({
    host,
    port,
    allowedHosts,
    createServer,
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    ...auth,
  });
}

async function shutdown(signal: string, exitCode: 0 | 1 = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down");
  try {
    if (httpHandle) await httpHandle.close();
    if (stdioServer) await stdioServer.close();
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, "Error during shutdown");
  } finally {
    // Give pino's async write a tick to flush the final log lines.
    // .unref() so this timer doesn't itself keep the loop alive.
    setTimeout(() => process.exit(exitCode), 50).unref();
  }
}

async function main(): Promise<void> {
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, "Uncaught exception");
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ reason: String(reason) }, "Unhandled rejection");
    void shutdown("unhandledRejection", 1);
  });

  const mode = process.env.MCP_TRANSPORT ?? "stdio";
  if (mode === "stdio") {
    await runStdio();
  } else if (mode === "http") {
    await runHttp();
  } else {
    throw new Error(`Unknown MCP_TRANSPORT: ${mode}`);
  }
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? { msg: err.message, stack: err.stack } : err }, "fatal");
  process.exit(1);
});
