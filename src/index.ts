#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
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

  const app = createMcpExpressApp(allowedHosts ? { host, allowedHosts } : { host });

  const server = createServer();
  // Stateless: no per-session state, every request initializes its own context.
  // Aligns with the 2026 roadmap "horizontal scaling without sessions" priority.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  app.post("/mcp", async (req, res) => {
    try {
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err }, "POST /mcp handler error");
      if (!res.headersSent) res.status(500).end();
    }
  });
  app.get("/mcp", async (req, res) => {
    try {
      await transport.handleRequest(req, res);
    } catch (err) {
      logger.error({ err }, "GET /mcp handler error");
      if (!res.headersSent) res.status(500).end();
    }
  });
  app.delete("/mcp", async (req, res) => {
    try {
      await transport.handleRequest(req, res);
    } catch (err) {
      logger.error({ err }, "DELETE /mcp handler error");
      if (!res.headersSent) res.status(500).end();
    }
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION });
  });

  app.listen(port, host, () => {
    logger.info({ host, port, url: `http://${host}:${port}/mcp` }, "Streamable HTTP transport ready");
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
