import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getBudget, getFundingSource } from "../api/mtender.js";
import { OcidSchema, BudgetSummary, FundingSummary } from "../schemas.js";
import { READ_ONLY } from "./_shared.js";

export function registerBudgetTools(server: McpServer): void {
  // ────────────────────────────────────────────────────────────────────────
  // get_budget / get_funding_source — keep as-is (already fast & complete)
  // ────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "get_budget",
    {
      title: "Get budget",
      description: "Fetch the planning budget linked to a procurement process by OCID.",
      inputSchema: { ocid: OcidSchema },
      outputSchema: BudgetSummary.shape,
      annotations: { ...READ_ONLY, title: "Get budget" },
    },
    async ({ ocid }, ctx) => {
      const b = await getBudget(ocid, ctx.signal);
      return {
        structuredContent: b,
        content: [
          {
            type: "resource_link",
            uri: `mtender://budgets/${ocid}`,
            name: b.budgetId ?? ocid,
            mimeType: "application/json",
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_funding_source",
    {
      title: "Get funding source",
      description: "Fetch the funding source record linked to a procurement budget by OCID.",
      inputSchema: { ocid: OcidSchema },
      outputSchema: FundingSummary.shape,
      annotations: { ...READ_ONLY, title: "Get funding source" },
    },
    async ({ ocid }, ctx) => {
      const f = await getFundingSource(ocid, ctx.signal);
      return {
        structuredContent: f,
        content: [
          {
            type: "resource_link",
            uri: `mtender://funding/${ocid}`,
            name: f.fundingSourceId,
            mimeType: "application/json",
          },
        ],
      };
    },
  );
}
