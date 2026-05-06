import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listTenders,
  listContractNotices,
  listPlans,
  listBudgets,
  compileTender,
} from "../api/mtender.js";
import { mapBounded } from "../concurrency.js";
import { TenderListItem } from "../schemas.js";
import { logger } from "../logger.js";
import { READ_ONLY, progress, tenderLink } from "./_shared.js";

export function registerSearchTools(server: McpServer): void {
  // ────────────────────────────────────────────────────────────────────────
  // search_tenders — paginated listing with optional client-side filters.
  // Upstream /tenders/ accepts only `offset`; richer filters require fetch.
  // ────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "search_tenders",
    {
      title: "Search tenders",
      description:
        "List Moldova procurement notices, ascending by publication date. Returns lightweight {ocid, date} entries plus resource_link blocks. Without `offset`, defaults to the last ~30 days. Use the returned `nextOffset` to paginate forward in time. For richer filters (buyer/supplier/CPV/value/status), use search_tenders_deep.",
      inputSchema: {
        offset: z
          .string()
          .optional()
          .describe(
            "ISO date offset cursor. Returns 100 entries starting from this date forward. Default: 30 days ago.",
          ),
        limit: z.number().int().positive().max(500).default(100),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
      },
      outputSchema: {
        items: z.array(TenderListItem),
        count: z.number(),
        nextOffset: z.string().optional(),
      },
      annotations: { ...READ_ONLY, title: "Search tenders" },
    },
    async ({ offset, limit, dateFrom, dateTo }, ctx) => {
      const { data, nextOffset } = await listTenders({ offset, limit, signal: ctx.signal });
      const from = dateFrom ? new Date(dateFrom).getTime() : -Infinity;
      const to = dateTo ? new Date(dateTo).getTime() : Infinity;
      const filtered = data.filter((d) => {
        const t = new Date(d.date).getTime();
        return t >= from && t <= to;
      });
      const limited = filtered.slice(0, limit);
      return {
        structuredContent: { items: limited, count: limited.length, nextOffset },
        content: [
          { type: "text", text: `Found ${limited.length} tenders.` },
          ...limited.map((d) => tenderLink(d.ocid, d.ocid, `Tender dated ${d.date}`)),
        ],
      };
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // search_tenders_deep — fetch + filter on richer fields. Slow.
  // ────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "search_tenders_deep",
    {
      title: "Deep tender search",
      description:
        "Fetch the latest N tenders and filter by buyer name, supplier name, CPV prefix, status, procurement method, or value range. Slow (one upstream call per tender). Use only when search_tenders is insufficient. Concurrency-bounded; emits progress.",
      inputSchema: {
        scanLatest: z.number().int().positive().max(500).default(100),
        buyerContains: z.string().optional(),
        supplierContains: z.string().optional(),
        cpvPrefix: z
          .string()
          .optional()
          .describe("CPV classification ID prefix, e.g. '45233' for road construction"),
        status: z.string().optional(),
        procurementMethod: z.string().optional(),
        minValue: z.number().optional(),
        maxValue: z.number().optional(),
      },
      outputSchema: {
        matches: z.array(z.object({ ocid: z.string(), title: z.string().optional(), value: z.number().optional() })),
        scanned: z.number(),
      },
      annotations: { ...READ_ONLY, title: "Deep tender search" },
    },
    async (input, ctx) => {
      const { data } = await listTenders({ signal: ctx.signal });
      const targets = data.slice(0, input.scanLatest);
      let scanned = 0;
      const results = await mapBounded(
        targets,
        4,
        async (t) => {
          try {
            const { summary } = await compileTender(t.ocid, { signal: ctx.signal });
            if (input.buyerContains && !(summary.buyer ?? "").toLowerCase().includes(input.buyerContains.toLowerCase()))
              return null;
            if (input.supplierContains) {
              const matched = summary.awards.some((a) =>
                a.suppliers.some((s) => s.name.toLowerCase().includes(input.supplierContains!.toLowerCase())),
              );
              if (!matched) return null;
            }
            if (input.cpvPrefix) {
              const matched = summary.items.some((it) =>
                (it.classification?.id ?? "").startsWith(input.cpvPrefix!),
              );
              if (!matched) return null;
            }
            if (input.status && summary.status !== input.status) return null;
            if (input.procurementMethod && summary.procurementMethod !== input.procurementMethod) return null;
            const vAmt = summary.value?.amount;
            if (input.minValue !== undefined && (vAmt ?? -Infinity) < input.minValue) return null;
            if (input.maxValue !== undefined && (vAmt ?? Infinity) > input.maxValue) return null;
            return { ocid: summary.ocid, title: summary.title, value: vAmt };
          } catch (e) {
            logger.debug({ ocid: t.ocid, err: (e as Error).message }, "deep search skip");
            return null;
          }
        },
        async (done, total) => {
          scanned = done;
          await progress(ctx, done, total, `${done}/${total} scanned`);
        },
      );
      const matches = results.filter((r): r is NonNullable<typeof r> => r !== null);
      return {
        structuredContent: { matches, scanned },
        content: [
          { type: "text", text: `Scanned ${scanned}, matched ${matches.length}.` },
          ...matches.map((m) => tenderLink(m.ocid, m.title)),
        ],
      };
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // search_contract_notices / search_plans / search_budgets — separate
  // upstream listing endpoints with the same {ocid, date} shape.
  // ────────────────────────────────────────────────────────────────────────
  for (const [name, listFn, label, scope] of [
    ["search_contract_notices", listContractNotices, "active contract notices (CN)", "/tenders/cn"],
    ["search_plans", listPlans, "planning records (forward-looking pipeline)", "/tenders/plan"],
    ["search_budgets", listBudgets, "budget records", "/budgets"],
  ] as const) {
    server.registerTool(
      name,
      {
        title: name.replace(/_/g, " "),
        description: `List ${label}. Defaults to last 30 days. Upstream: ${scope}.`,
        inputSchema: {
          offset: z.string().optional(),
          limit: z.number().int().positive().max(500).default(100),
        },
        outputSchema: {
          items: z.array(TenderListItem),
          count: z.number(),
          nextOffset: z.string().optional(),
        },
        annotations: { ...READ_ONLY, title: name },
      },
      async ({ offset, limit }, ctx) => {
        const { data, nextOffset } = await listFn({ offset, limit, signal: ctx.signal });
        const limited = data.slice(0, limit);
        return {
          structuredContent: { items: limited, count: limited.length, nextOffset },
          content: [
            { type: "text", text: `${limited.length} ${label}.` },
            ...limited.map((d) => tenderLink(d.ocid, d.ocid, d.date)),
          ],
        };
      },
    );
  }
}
