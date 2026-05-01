import pino from "pino";

// Logging MUST go to stderr per the MCP stdio transport spec; stdout belongs to JSON-RPC.
export const logger = pino(
  { level: process.env.LOG_LEVEL ?? "info", base: { svc: "mtender-mcp" } },
  pino.destination(2),
);
