import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listTenders,
  listContractNotices,
  listPlans,
  listBudgets,
  compileTender,
  getReleaseHistory,
  getBudget,
  getFundingSource,
  fetchDocument,
} from "./api/mtender.js";
import { mapBounded } from "./concurrency.js";
import {
  OcidSchema,
  TenderListItem,
  TenderSummary,
  BudgetSummary,
  FundingSummary,
  ReleaseHistoryItem,
  Document,
  Enquiry,
  Lot,
  BidStatistic,
  BuyerAggRow,
  SupplierAggRow,
} from "./schemas.js";
import { validateDocumentUrl } from "./ssrf.js";
import { extractDocument } from "./document.js";
import { logger } from "./logger.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: true, idempotentHint: true } as const;

interface ToolCtx {
  signal?: AbortSignal;
  sendNotification?: (n: any) => Promise<void>;
  _meta?: { progressToken?: string | number };
}

async function progress(
  ctx: ToolCtx,
  done: number,
  total: number,
  message: string,
): Promise<void> {
  const token = ctx._meta?.progressToken;
  if (token === undefined || !ctx.sendNotification) return;
  await ctx.sendNotification({
    method: "notifications/progress",
    params: { progressToken: token, progress: done, total, message },
  });
}

function tenderLink(ocid: string, name?: string, description?: string) {
  return {
    type: "resource_link" as const,
    uri: `mtender://tenders/${ocid}`,
    name: name ?? ocid,
    ...(description ? { description } : {}),
    mimeType: "application/json",
  };
}

// Scan the latest N tenders and compile each. Used by aggregators and red-flag
// scanners. Returns summaries (null on per-tender error so the scan continues).
async function scanLatestSummaries(
  scanLatest: number,
  ctx: ToolCtx,
): Promise<Array<TenderSummary | null>> {
  const { data } = await listTenders({ signal: ctx.signal });
  const targets = data.slice(0, scanLatest);
  return mapBounded(
    targets,
    4,
    async (t) => {
      try {
        return (await compileTender(t.ocid, { signal: ctx.signal })).summary;
      } catch {
        return null;
      }
    },
    async (d, total) => progress(ctx, d, total, `${d}/${total}`),
  );
}

export function registerTools(server: McpServer): void {
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
      const { data, nextOffset } = await listTenders({ offset, signal: ctx.signal });
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
  // get_tender — full compiled summary across all release packages.
  // ────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "get_tender",
    {
      title: "Get tender",
      description:
        "Compile a full OCDS tender summary by fetching every release package (PN/TN/EV/AC/CO) and merging them. Returns parties, items (with CPV), documents, amendments, awards, contracts, related processes.",
      inputSchema: { ocid: OcidSchema },
      outputSchema: TenderSummary.shape,
      annotations: { ...READ_ONLY, title: "Get tender" },
    },
    async ({ ocid }, ctx) => {
      const { summary } = await compileTender(ocid, {
        signal: ctx.signal,
        onProgress: (d, t) => progress(ctx, d, t, `Fetching release ${d}/${t}`),
      });
      return {
        structuredContent: summary,
        content: [
          tenderLink(ocid, summary.title),
          { type: "text", text: renderTender(summary) },
        ],
      };
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // list_tender_documents
  // ────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "list_tender_documents",
    {
      title: "List tender documents",
      description: "List every document URL attached to a tender across its releases (tender, awards, contracts).",
      inputSchema: { ocid: OcidSchema },
      outputSchema: {
        documents: z.array(Document.extend({ scope: z.string() })),
        count: z.number(),
      },
      annotations: { ...READ_ONLY, title: "List tender documents" },
    },
    async ({ ocid }, ctx) => {
      const { summary } = await compileTender(ocid, { signal: ctx.signal });
      const docs = [
        ...summary.documents.map((d) => ({ ...d, scope: "tender" })),
        ...summary.awards.flatMap((a) => a.documents.map((d) => ({ ...d, scope: `award:${a.id ?? "?"}` }))),
        ...summary.contracts.flatMap((c) => c.documents.map((d) => ({ ...d, scope: `contract:${c.id ?? "?"}` }))),
      ];
      return {
        structuredContent: { documents: docs, count: docs.length },
        content: [{ type: "text", text: `${docs.length} documents on ${ocid}` }],
      };
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // get_release_history — temporal view of releases (PN, TN, amendments, etc.)
  // ────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "get_release_history",
    {
      title: "Get release history",
      description:
        "Return a chronological list of OCDS releases for a tender (planningUpdate, tender, award, contract, amendment, tenderCancellation, etc.) with their tags and timestamps.",
      inputSchema: { ocid: OcidSchema },
      outputSchema: { releases: z.array(ReleaseHistoryItem), count: z.number() },
      annotations: { ...READ_ONLY, title: "Get release history" },
    },
    async ({ ocid }, ctx) => {
      const releases = await getReleaseHistory(ocid, ctx.signal);
      return {
        structuredContent: { releases, count: releases.length },
        content: [
          {
            type: "text",
            text: releases.map((r) => `${r.date}  ${(r.tag ?? []).join(",")}  ${r.releaseId}`).join("\n") || "No releases",
          },
        ],
      };
    },
  );

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

  // ────────────────────────────────────────────────────────────────────────
  // aggregate_by_buyer / aggregate_by_supplier
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
      return {
        structuredContent: { rows, scanned: summaries.filter(Boolean).length },
        content: [{ type: "text", text: `Top buyer: ${rows[0]?.buyer ?? "n/a"}` }],
      };
    },
  );

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
      return {
        structuredContent: { rows, scanned: summaries.filter(Boolean).length },
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
      return {
        structuredContent: { flagged, scanned },
        content: [{ type: "text", text: `Flagged ${flagged.length}/${scanned}` }],
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
        const { data, nextOffset } = await listFn({ offset, signal: ctx.signal });
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

  // ────────────────────────────────────────────────────────────────────────
  // list_enquiries — public Q&A on a tender (bidder ↔ buyer)
  // ────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "list_enquiries",
    {
      title: "List enquiries",
      description:
        "Return the public Q&A thread on a tender — questions submitted by potential bidders and the buyer's answers (OCDS enquiry extension).",
      inputSchema: { ocid: OcidSchema },
      outputSchema: { enquiries: z.array(Enquiry), count: z.number() },
      annotations: { ...READ_ONLY, title: "List enquiries" },
    },
    async ({ ocid }, ctx) => {
      const { summary } = await compileTender(ocid, { signal: ctx.signal });
      return {
        structuredContent: { enquiries: summary.enquiries, count: summary.enquiries.length },
        content: [{ type: "text", text: `${summary.enquiries.length} enquiries on ${ocid}` }],
      };
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // list_lots — multi-lot tender breakdown
  // ────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "list_lots",
    {
      title: "List lots",
      description:
        "Return the lots of a tender — many Moldovan procurements are split into separately-evaluated lots, each with its own status, value, and items.",
      inputSchema: { ocid: OcidSchema },
      outputSchema: { lots: z.array(Lot), count: z.number() },
      annotations: { ...READ_ONLY, title: "List lots" },
    },
    async ({ ocid }, ctx) => {
      const { summary } = await compileTender(ocid, { signal: ctx.signal });
      return {
        structuredContent: { lots: summary.lots, count: summary.lots.length },
        content: [{ type: "text", text: `${summary.lots.length} lots on ${ocid}` }],
      };
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // list_bid_statistics — when present (OCDS bids extension)
  // ────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "list_bid_statistics",
    {
      title: "List bid statistics",
      description:
        "Return bid statistics for a tender (OCDS bids extension). Measures include bids submitted, valid bids, etc., per-lot.",
      inputSchema: { ocid: OcidSchema },
      outputSchema: { statistics: z.array(BidStatistic), count: z.number() },
      annotations: { ...READ_ONLY, title: "List bid statistics" },
    },
    async ({ ocid }, ctx) => {
      const { summary } = await compileTender(ocid, { signal: ctx.signal });
      return {
        structuredContent: { statistics: summary.bidStatistics, count: summary.bidStatistics.length },
        content: [{ type: "text", text: `${summary.bidStatistics.length} bid statistics on ${ocid}` }],
      };
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // fetch_tender_document — only true side-effecting tool.
  // ────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "fetch_tender_document",
    {
      title: "Fetch tender document",
      description:
        "Download a document from Moldova's MTender storage and return its content. " +
        "PDF: native-text PDFs return extracted text; scanned PDFs (common in Moldovan procurement) return per-page JPEG `image` content blocks for the host's vision model to OCR — language-agnostic, handles Romanian / Russian / English / mixed without local OCR. " +
        "DOCX: returns Markdown with tables preserved (GFM). " +
        "TXT: UTF-8 text. " +
        "URL is validated against the official storage host and DNS-resolved to a non-private IP before fetching to defeat SSRF / rebinding.",
      inputSchema: {
        documentUrl: z
          .string()
          .url()
          .describe("https://storage.mtender.gov.md/get/<id>-<ts> URL"),
        mode: z
          .enum(["auto", "text", "image"])
          .default("auto")
          .describe(
            "auto = text first, image fallback for scanned PDFs (default). " +
              "text = always return extracted text only. " +
              "image = always return page images (forces vision-OCR path).",
          ),
      },
      outputSchema: {
        text: z.string(),
        pages: z.number().optional(),
        contentType: z.string(),
        bytes: z.number(),
        filename: z.string().optional(),
        scanned: z.boolean(),
        imageCount: z.number(),
      },
      annotations: {
        title: "Fetch tender document",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ documentUrl, mode }, ctx) => {
      const validated = await validateDocumentUrl(documentUrl);
      logger.debug({ url: validated.url.href, ip: validated.resolvedIp, mode }, "fetching document");
      await progress(ctx, 1, 3, "URL validated");
      const { buffer, contentType, filename } = await fetchDocument(validated, ctx.signal);
      await progress(ctx, 2, 3, `Downloaded ${buffer.byteLength} bytes`);
      const extracted = await extractDocument(buffer, contentType, mode);
      await progress(ctx, 3, 3, extracted.scanned ? "Scanned PDF: returning page images" : "Extracted text");

      const imageParts = extracted.parts.filter((p) => p.type === "image");
      const textParts = extracted.parts.filter((p) => p.type === "text");

      const inlineText =
        textParts[0]?.text && textParts[0].text.length > 8000
          ? textParts[0].text.slice(0, 8000) +
            "\n\n[…text truncated for inline display; full text in structuredContent]"
          : (textParts[0]?.text ?? "");

      const content: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [];

      if (extracted.scanned && imageParts.length) {
        content.push({
          type: "text",
          text: `Scanned PDF detected (${extracted.pages} pages). Embedded extracted text was unreliable; returning ${imageParts.length} page image(s) for vision OCR. ${
            inlineText ? "Best-effort text below for fallback reference:\n\n" + inlineText : ""
          }`,
        });
      } else if (inlineText) {
        content.push({ type: "text", text: inlineText });
      }

      for (const im of imageParts) {
        content.push({ type: "image", data: im.imageBase64!, mimeType: im.mimeType! });
      }

      return {
        structuredContent: {
          text: extracted.text,
          pages: extracted.pages,
          contentType: extracted.contentType,
          bytes: buffer.byteLength,
          filename,
          scanned: extracted.scanned,
          imageCount: imageParts.length,
        },
        content,
      };
    },
  );
}

function renderTender(t: TenderSummary): string {
  const out: string[] = [];
  out.push(`# Tender ${t.ocid}`);
  if (t.title) out.push(`Title: ${t.title}`);
  if (t.status) out.push(`Status: ${t.status}${t.statusDetails ? ` (${t.statusDetails})` : ""}`);
  if (t.procurementMethod) out.push(`Method: ${t.procurementMethod}`);
  if (t.mainProcurementCategory) out.push(`Category: ${t.mainProcurementCategory}`);
  if (t.value) out.push(`Value: ${t.value.amount} ${t.value.currency}`);
  if (t.buyer) out.push(`Buyer: ${t.buyer}`);
  if (t.tenderPeriod) out.push(`Tender period: ${t.tenderPeriod.startDate ?? "?"} → ${t.tenderPeriod.endDate ?? "?"}`);
  if (t.parties.length) out.push(`Parties: ${t.parties.length}`);
  if (t.items.length) out.push(`Items: ${t.items.length}`);
  if (t.documents.length) out.push(`Documents: ${t.documents.length}`);
  if (t.amendments.length) out.push(`Amendments: ${t.amendments.length}`);
  if (t.awards.length) out.push(`Awards: ${t.awards.length}`);
  if (t.contracts.length) out.push(`Contracts: ${t.contracts.length}`);
  return out.join("\n");
}
