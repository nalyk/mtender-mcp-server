#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { startHttpServer } from "./http.js";
import { logger } from "./logger.js";

async function runStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info({ name: SERVER_NAME, version: SERVER_VERSION }, "stdio transport ready");
}

async function runHttp(): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "127.0.0.1";
  const allowedHostsEnv = process.env.ALLOWED_HOSTS;
  const allowedHosts = allowedHostsEnv?.split(",").map((s) => s.trim()).filter(Boolean);

  await startHttpServer({
    host,
    port,
    allowedHosts,
    createServer,
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
  });
}

async function main(): Promise<void> {
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
