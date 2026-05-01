import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import { recentOcids } from "./resources.js";

const ocidArg = (description: string) =>
  completable(z.string().describe(description), async (value) =>
    (await recentOcids().catch(() => [])).filter((o) => o.startsWith(value)).slice(0, 25),
  );

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "analyze-procurement",
    {
      title: "Analyze a Moldova procurement",
      description:
        "End-to-end OCDS analysis of one tender: planning → tender → awards → contracts. Pulls the full compiled record, lists documents, summarizes parties, items, value, and key risks.",
      argsSchema: {
        ocid: ocidArg("OCDS OCID, e.g. ocds-b3wdp1-MD-1613996912600"),
        focus: z
          .enum(["overview", "value", "competition", "compliance"])
          .optional()
          .describe("Optional analysis focus (defaults to overview)"),
      },
    },
    ({ ocid, focus }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Analyze procurement ${ocid} with a ${focus ?? "overview"} lens.\n\n` +
              `1. Call get_tender to compile the full OCDS record (parties, items, awards, contracts).\n` +
              `2. Call get_release_history to see the temporal evolution.\n` +
              `3. Call get_budget and get_funding_source.\n` +
              `4. Call list_tender_documents and fetch_tender_document on substantive docs (RFP, technical specs).\n` +
              `5. Produce a structured summary: buyer, total value, procurement method, items+CPV, awards+suppliers, contracts, amendments, anomalies.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "compare-tenders",
    {
      title: "Compare two tenders",
      description:
        "Side-by-side comparison of two Moldova procurements. Useful when an agent suspects related/duplicate procurements or wants to compare suppliers/values across similar contracts.",
      argsSchema: {
        ocidA: ocidArg("First OCID"),
        ocidB: ocidArg("Second OCID"),
      },
    },
    ({ ocidA, ocidB }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Compare procurements ${ocidA} and ${ocidB}.\n\n` +
              `Call get_tender on both. Build a side-by-side table covering: buyer, value, procurement method, items count + dominant CPV, supplier set, contract values, amendments count, status. Highlight anything suspicious (same buyer + same supplier + similar value, or large amendment ratio).`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "audit-supplier",
    {
      title: "Audit a supplier across recent tenders",
      description:
        "Find every recent award to a named supplier and characterize their footprint. Uses search_tenders_deep + aggregate_by_supplier.",
      argsSchema: {
        supplier: z.string().describe("Supplier name (substring match, case-insensitive)"),
        scanLatest: z.string().optional().describe("How many recent tenders to scan (default 100)"),
      },
    },
    ({ supplier, scanLatest }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Audit supplier "${supplier}" across the latest ${scanLatest ?? "100"} Moldova tenders.\n\n` +
              `1. Call search_tenders_deep with supplierContains="${supplier}" and scanLatest=${scanLatest ?? "100"}.\n` +
              `2. For each match, call get_tender and capture: buyer, value, item categories, contract status.\n` +
              `3. Optionally call aggregate_by_supplier to confirm rank.\n` +
              `4. Produce: total awarded value, top 3 buyers, dominant CPV categories, single-bid count, geographic spread, amendment ratio. Flag concerns.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "single-bid-investigation",
    {
      title: "Investigate single-bid awards",
      description:
        "Surface tenders awarded to a single supplier (red flag for limited competition) and characterize the pattern.",
      argsSchema: {
        scanLatest: z.string().optional().describe("How many recent tenders to scan (default 100)"),
      },
    },
    ({ scanLatest }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Investigate single-bid awards in Moldova procurement.\n\n` +
              `1. Call flag_single_bid_awards with scanLatest=${scanLatest ?? "100"}.\n` +
              `2. For each flagged tender, call get_tender to capture buyer, value, supplier.\n` +
              `3. Group flags by buyer and by supplier. Highlight any buyer-supplier pair appearing more than twice — that's a high-priority audit target.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "enquiry-review",
    {
      title: "Review tender Q&A",
      description:
        "Read all enquiries (questions from bidders, answers from buyer) on a tender and assess: were the buyer's answers substantive, did anything change late, were any technical specs clarified after the fact?",
      argsSchema: { ocid: ocidArg("OCID of the tender to review") },
    },
    ({ ocid }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Review the public Q&A on tender ${ocid}.\n\n` +
              `1. Call list_enquiries to fetch the dialog.\n` +
              `2. For each enquiry, summarize the question, evaluate whether the answer is substantive, and flag late or evasive answers.\n` +
              `3. If amendments exist (call get_release_history), correlate amendments to enquiries — did the buyer change specs in response to a question?`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "lot-breakdown",
    {
      title: "Lot-by-lot tender breakdown",
      description:
        "Walk a multi-lot tender lot-by-lot, surfacing per-lot status, value, items, and award outcome (or cancellation reason).",
      argsSchema: { ocid: ocidArg("OCID of a multi-lot tender") },
    },
    ({ ocid }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Break down tender ${ocid} lot by lot.\n\n` +
              `1. Call list_lots and get_tender.\n` +
              `2. For each lot: status, value, item count + dominant CPV from items where relatedLot matches the lot id, the award outcome (if any), winning supplier.\n` +
              `3. Highlight cancelled lots vs awarded lots and the reasons.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "pipeline-overview",
    {
      title: "Procurement pipeline overview",
      description:
        "Show what's flowing through the Moldova procurement pipeline right now: planning records, active contract notices, signed contracts.",
      argsSchema: {},
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Summarize Moldova's procurement pipeline.\n\n` +
              `1. Read mtender://plans/latest to see what's planned.\n` +
              `2. Read mtender://contract-notices/latest to see what's currently being tendered.\n` +
              `3. Read mtender://tenders/latest to see all recent activity.\n` +
              `4. Optionally call aggregate_by_buyer to rank top buyers.\n` +
              `5. Produce a forward-looking summary: planned procurements, open competitions, top categories (CPV).`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "buyer-spend-overview",
    {
      title: "Top buyers by spend",
      description:
        "Rank Moldova procurement buyers by total tender value across the latest N tenders. Useful for fiscal-year overview.",
      argsSchema: {
        scanLatest: z.string().optional().describe("How many recent tenders to scan (default 100)"),
      },
    },
    ({ scanLatest }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Rank Moldova procurement buyers by total tender value.\n\n` +
              `1. Call aggregate_by_buyer with scanLatest=${scanLatest ?? "100"}.\n` +
              `2. Present the top 10 buyers with their tender count and total value.\n` +
              `3. For the #1 buyer, call search_tenders_deep with buyerContains=<that name> and list their recent procurements.`,
          },
        },
      ],
    }),
  );
}
