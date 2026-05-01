import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  listTenders,
  listContractNotices,
  listPlans,
  listBudgets,
  compileTender,
  getReleaseHistory,
  getBudget,
  getFundingSource,
  getUpstreamHealth,
} from "./api/mtender.js";

let ocidCache: { ocids: string[]; expires: number } | undefined;
async function recentOcids(): Promise<string[]> {
  const now = Date.now();
  if (ocidCache && ocidCache.expires > now) return ocidCache.ocids;
  const { data } = await listTenders({});
  const ocids = data.map((d) => d.ocid);
  ocidCache = { ocids, expires: now + 60_000 };
  return ocids;
}

function jsonContents(uri: URL, body: unknown) {
  return {
    contents: [
      { uri: uri.href, mimeType: "application/json", text: JSON.stringify(body, null, 2) },
    ],
  };
}

// Completion provider shared by every OCID-templated resource.
const completeOcid = {
  ocid: async (value: string): Promise<string[]> =>
    (await recentOcids().catch(() => [])).filter((o) => o.startsWith(value)).slice(0, 25),
};

export function registerResources(server: McpServer): void {
  // ── Static "latest" listings ──────────────────────────────────────────
  function registerListing(
    name: string,
    uri: string,
    title: string,
    description: string,
    fetcher: () => Promise<{ data: unknown }>,
  ): void {
    server.registerResource(
      name,
      uri,
      { title, description, mimeType: "application/json" },
      async (u) => jsonContents(u, (await fetcher()).data),
    );
  }

  registerListing(
    "latest-tenders",
    "mtender://tenders/latest",
    "Latest Moldova tenders",
    "Most recent ~100 procurement notices ({ocid, date}) from the last 30 days.",
    () => listTenders({}),
  );
  registerListing(
    "latest-contract-notices",
    "mtender://contract-notices/latest",
    "Latest active contract notices (CN)",
    "100 most recent contract-notice releases — currently-tendering procurements (last 30 days).",
    () => listContractNotices({}),
  );
  registerListing(
    "latest-plans",
    "mtender://plans/latest",
    "Latest Moldova procurement plans",
    "100 most recent planning records — forward-looking procurement pipeline (last 30 days).",
    () => listPlans({}),
  );
  registerListing(
    "latest-budgets",
    "mtender://budgets/latest",
    "Latest Moldova budgets",
    "100 most recent budget records (last 30 days).",
    () => listBudgets({}),
  );

  // upstream-health follows the same shape but pulls a different shape from
  // the API (no .data wrapper) so it gets its own registration.
  server.registerResource(
    "upstream-health",
    "mtender://upstream/health",
    {
      title: "MTender upstream health",
      description: "Reports the upstream public.mtender.gov.md /actuator/health + build info.",
      mimeType: "application/json",
    },
    async (uri) => jsonContents(uri, await getUpstreamHealth()),
  );

  // ── Templated resources keyed by OCID ─────────────────────────────────
  server.registerResource(
    "tender",
    new ResourceTemplate("mtender://tenders/{ocid}", {
      list: async () => {
        const { data } = await listTenders({});
        return {
          resources: data.slice(0, 50).map((d) => ({
            uri: `mtender://tenders/${d.ocid}`,
            name: d.ocid,
            mimeType: "application/json",
          })),
        };
      },
      complete: completeOcid,
    }),
    {
      title: "Tender by OCID",
      description: "Full compiled OCDS tender (parties, items, awards, contracts, documents).",
      mimeType: "application/json",
    },
    async (uri, vars) => jsonContents(uri, (await compileTender(String(vars.ocid))).summary),
  );

  server.registerResource(
    "release-history",
    new ResourceTemplate("mtender://tenders/{ocid}/releases", {
      list: undefined,
      complete: completeOcid,
    }),
    {
      title: "Tender release history",
      description: "Chronological OCDS releases for a tender (planning, tender, award, contract, amendments).",
      mimeType: "application/json",
    },
    async (uri, vars) => jsonContents(uri, await getReleaseHistory(String(vars.ocid))),
  );

  server.registerResource(
    "budget",
    new ResourceTemplate("mtender://budgets/{ocid}", {
      list: undefined,
      complete: completeOcid,
    }),
    {
      title: "Budget by OCID",
      description: "Planning budget linked to a procurement process.",
      mimeType: "application/json",
    },
    async (uri, vars) => jsonContents(uri, await getBudget(String(vars.ocid))),
  );

  server.registerResource(
    "funding",
    new ResourceTemplate("mtender://funding/{ocid}", {
      list: undefined,
      complete: completeOcid,
    }),
    {
      title: "Funding source by OCID",
      description: "Funding source record linked to a procurement budget.",
      mimeType: "application/json",
    },
    async (uri, vars) => jsonContents(uri, await getFundingSource(String(vars.ocid))),
  );
}

export { recentOcids };
