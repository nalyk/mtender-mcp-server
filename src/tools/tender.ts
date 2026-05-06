import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compileTender, getReleaseHistory } from "../api/mtender.js";
import {
  OcidSchema,
  TenderSummary,
  ReleaseHistoryItem,
  Document,
  Enquiry,
  Lot,
  BidStatistic,
} from "../schemas.js";
import { READ_ONLY, progress, tenderLink, renderTender } from "./_shared.js";

export function registerTenderTools(server: McpServer): void {
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
}
