import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server as HttpListener } from "node:http";
import { logger } from "./logger.js";

export interface StartHttpServerOptions {
  host: string;
  port: number;
  allowedHosts?: string[];
  createServer: () => McpServer;
  serverName: string;
  serverVersion: string;
}

export interface HttpServerHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
}

const METHOD_NOT_ALLOWED_BODY = JSON.stringify({
  jsonrpc: "2.0",
  error: { code: -32000, message: "Method not allowed." },
  id: null,
});

// Stateless Streamable HTTP per the SDK contract: every POST /mcp gets a
// fresh McpServer + StreamableHTTPServerTransport pair, instantiated INSIDE
// the route handler. Reusing a single transport across requests breaks at
// the second request (SDK ≥ 1.26 throws "Already connected to a transport"
// or "Stateless transport cannot be reused across requests"). The canonical
// shape of this handler mirrors the SDK example:
//   examples/server/simpleStatelessStreamableHttp.js
// GET and DELETE are explicitly 405 because in stateless mode there is no
// server-to-client SSE stream to attach to and no session to terminate.
export async function startHttpServer(opts: StartHttpServerOptions): Promise<HttpServerHandle> {
  const app = createMcpExpressApp(
    opts.allowedHosts
      ? { host: opts.host, allowedHosts: opts.allowedHosts }
      : { host: opts.host },
  );

  app.post("/mcp", async (req, res) => {
    const server = opts.createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close().catch((err) => logger.error({ err }, "transport.close error"));
        server.close().catch((err) => logger.error({ err }, "server.close error"));
      });
    } catch (err) {
      logger.error({ err }, "POST /mcp handler error");
      // Best-effort cleanup on early failure (e.g. before res.on('close') is wired).
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
      if (!res.headersSent) res.status(500).end();
    }
  });

  app.get("/mcp", (_req, res) => {
    res.writeHead(405, { "Content-Type": "application/json" }).end(METHOD_NOT_ALLOWED_BODY);
  });
  app.delete("/mcp", (_req, res) => {
    res.writeHead(405, { "Content-Type": "application/json" }).end(METHOD_NOT_ALLOWED_BODY);
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: opts.serverName, version: opts.serverVersion });
  });

  const listener = await new Promise<HttpListener>((resolve, reject) => {
    const srv = app.listen(opts.port, opts.host, () => resolve(srv));
    srv.once("error", reject);
  });

  const addr = listener.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : opts.port;
  const url = `http://${opts.host}:${port}/mcp`;

  logger.info({ host: opts.host, port, url }, "Streamable HTTP transport ready");

  return {
    port,
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        listener.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
