#!/usr/bin/env node
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { startHttpServer, type HttpServerHandle } from "./http.js";
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

  httpHandle = await startHttpServer({
    host,
    port,
    allowedHosts,
    createServer,
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
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
