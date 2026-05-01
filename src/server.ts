import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerResources } from "./resources.js";
import { registerTools } from "./tools.js";
import { registerPrompts } from "./prompts.js";

export const SERVER_NAME = "mtender-mcp-server";
export const SERVER_VERSION = "3.0.0";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
        prompts: { listChanged: false },
        completions: {},
        logging: {},
      },
      instructions: [
        "Read OCDS-compliant Moldovan procurement data (Open Contracting Data Standard 1.1.5).",
        "",
        "Resources (direct read, preferred when you know the OCID or want a list):",
        "  mtender://tenders/latest               — most recent 100 procurements",
        "  mtender://contract-notices/latest      — currently tendering (CN)",
        "  mtender://plans/latest                 — planned procurements (forward-looking)",
        "  mtender://budgets/latest               — recent budgets",
        "  mtender://upstream/health              — upstream API health",
        "  mtender://tenders/{ocid}               — full compiled OCDS record",
        "  mtender://tenders/{ocid}/releases      — release timeline",
        "  mtender://budgets/{ocid}               — planning budget",
        "  mtender://funding/{ocid}               — funding source",
        "",
        "Tools (16):",
        "  search_tenders / search_contract_notices / search_plans / search_budgets",
        "  search_tenders_deep                    — buyer/supplier/CPV/value/status filters",
        "  get_tender                             — full compiled record (parties, lots, items, awards, contracts, enquiries, bids)",
        "  get_release_history                    — timeline by release tag",
        "  list_lots / list_enquiries / list_bid_statistics / list_tender_documents",
        "  get_budget / get_funding_source",
        "  aggregate_by_buyer / aggregate_by_supplier — fan-out scans",
        "  flag_single_bid_awards                 — limited-competition red flag",
        "  fetch_tender_document                  — SSRF-guarded PDF/DOCX extraction",
        "",
        "Prompts (8):",
        "  analyze-procurement, compare-tenders, audit-supplier,",
        "  single-bid-investigation, buyer-spend-overview,",
        "  enquiry-review, lot-breakdown, pipeline-overview",
      ].join("\n"),
    },
  );

  registerResources(server);
  registerTools(server);
  registerPrompts(server);

  return server;
}
