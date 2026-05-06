import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearchTools } from "./search.js";
import { registerTenderTools } from "./tender.js";
import { registerBudgetTools } from "./budget.js";
import { registerAnalyticsTools } from "./analytics.js";
import { registerDocumentTools } from "./document.js";

/** Register all 17 tools on the given server. Tools are grouped by domain;
 *  see ./search.ts, ./tender.ts, ./budget.ts, ./analytics.ts, ./document.ts. */
export function registerTools(server: McpServer): void {
  registerSearchTools(server);
  registerTenderTools(server);
  registerBudgetTools(server);
  registerAnalyticsTools(server);
  registerDocumentTools(server);
}
