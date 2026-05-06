import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BuyerAggRow, SupplierAggRow } from "../schemas.js";
import { READ_ONLY, logEvent, scanLatestSummaries } from "./_shared.js";

export function registerAnalyticsTools(server: McpServer): void {
  // ────────────────────────────────────────────────────────────────────────
  // aggregate_by_buyer
  // ────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "aggregate_by_buyer",
    {
      title: "Aggregate spend by buyer",
      description:
        "Scan the latest N tenders, group by buyer, return tender count + total tender value. Slow.",
      inputSchema: { scanLatest: z.number().int().positive().max(500).default(100) },
      outputSchema: { rows: z.array(BuyerAggRow), scanned: z.number() },
      annotations: { ...READ_ONLY, title: "Aggregate by buyer" },
    },
    async ({ scanLatest }, ctx) => {
      const summaries = await scanLatestSummaries(scanLatest, ctx);
      const buckets = new Map<string, { count: number; total: number; currency: string }>();
      for (const s of summaries) {
        if (!s) continue;
        const buyer = s.buyer ?? "(unknown)";
        // Prefer summed contract values, then summed award values, then tender estimate.
        const contractTotal = s.contracts.reduce((acc, c) => acc + (c.value?.amount ?? 0), 0);
        const awardTotal = s.awards.reduce((acc, a) => acc + (a.value?.amount ?? 0), 0);
        const v = contractTotal || awardTotal || s.value?.amount || 0;
        const c =
          s.contracts[0]?.value?.currency ?? s.awards[0]?.value?.currency ?? s.value?.currency ?? "MDL";
        const cur = buckets.get(buyer) ?? { count: 0, total: 0, currency: c };
        cur.count++;
        cur.total += v;
        cur.currency = c;
        buckets.set(buyer, cur);
      }
      const rows = [...buckets.entries()]
        .map(([buyer, v]) => ({ buyer, tenders: v.count, totalValue: v.total, currency: v.currency }))
        .sort((a, b) => b.totalValue - a.totalValue);
      const scanned = summaries.filter(Boolean).length;
      await logEvent(server, "info", {
        event: "aggregate_by_buyer.complete",
        scanned,
        buyersFound: rows.length,
        topBuyer: rows[0]?.buyer ?? null,
      });
      return {
        structuredContent: { rows, scanned },
        content: [{ type: "text", text: `Top buyer: ${rows[0]?.buyer ?? "n/a"}` }],
      };
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // aggregate_by_supplier
  // ────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "aggregate_by_supplier",
    {
      title: "Aggregate awards by supplier",
      description:
        "Scan the latest N tenders, count awards per supplier, return total awarded value + the OCIDs they appear in. Slow.",
      inputSchema: { scanLatest: z.number().int().positive().max(500).default(100) },
      outputSchema: { rows: z.array(SupplierAggRow), scanned: z.number() },
      annotations: { ...READ_ONLY, title: "Aggregate by supplier" },
    },
    async ({ scanLatest }, ctx) => {
      const summaries = await scanLatestSummaries(scanLatest, ctx);
      const buckets = new Map<string, { awards: number; total: number; currency: string; ocids: Set<string> }>();
      for (const s of summaries) {
        if (!s) continue;
        for (const a of s.awards) {
          const v = a.value?.amount ?? 0;
          const c = a.value?.currency ?? "MDL";
          for (const supplier of a.suppliers) {
            const key = supplier.name;
            const cur = buckets.get(key) ?? { awards: 0, total: 0, currency: c, ocids: new Set<string>() };
            cur.awards++;
            cur.total += v;
            cur.currency = c;
            cur.ocids.add(s.ocid);
            buckets.set(key, cur);
          }
        }
      }
      const rows = [...buckets.entries()]
        .map(([supplier, v]) => ({
          supplier,
          awards: v.awards,
          totalValue: v.total,
          currency: v.currency,
          ocids: [...v.ocids],
        }))
        .sort((a, b) => b.totalValue - a.totalValue);
      const scanned = summaries.filter(Boolean).length;
      await logEvent(server, "info", {
        event: "aggregate_by_supplier.complete",
        scanned,
        suppliersFound: rows.length,
        topSupplier: rows[0]?.supplier ?? null,
      });
      return {
        structuredContent: { rows, scanned },
        content: [{ type: "text", text: `Top supplier: ${rows[0]?.supplier ?? "n/a"}` }],
      };
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // flag_single_bid_awards — common red flag in procurement audits
  // ────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "flag_single_bid_awards",
    {
      title: "Flag single-bid awards",
      description:
        "Scan the latest N tenders and flag those whose award has only one supplier — a classic red flag for limited competition.",
      inputSchema: { scanLatest: z.number().int().positive().max(500).default(100) },
      outputSchema: {
        flagged: z.array(z.object({ ocid: z.string(), title: z.string().optional(), supplier: z.string() })),
        scanned: z.number(),
      },
      annotations: { ...READ_ONLY, title: "Flag single-bid awards" },
    },
    async ({ scanLatest }, ctx) => {
      const summaries = await scanLatestSummaries(scanLatest, ctx);
      const flagged: Array<{ ocid: string; title?: string; supplier: string }> = [];
      for (const s of summaries) {
        if (!s) continue;
        for (const a of s.awards) {
          if (a.suppliers.length === 1) {
            flagged.push({ ocid: s.ocid, title: s.title, supplier: a.suppliers[0]!.name });
          }
        }
      }
      const scanned = summaries.length;
      await logEvent(server, "warning", {
        event: "single_bid_scan.complete",
        scanned,
        flagged: flagged.length,
        rate: scanned > 0 ? flagged.length / scanned : 0,
      });
      return {
        structuredContent: { flagged, scanned },
        content: [{ type: "text", text: `Flagged ${flagged.length}/${scanned}` }],
      };
    },
  );
}
