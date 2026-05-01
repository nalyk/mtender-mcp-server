import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";

async function pair(): Promise<Client> {
  const server = createServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(b);
  return client;
}

test("initialize identifies as v3.1.0", async () => {
  const client = await pair();
  const v = client.getServerVersion();
  assert.equal(v?.name, "mtender-mcp-server");
  assert.equal(v?.version, "3.1.0");
  await client.close();
});

test("tools/list contains all 17 tools with outputSchema + annotations", async () => {
  const client = await pair();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "aggregate_by_buyer",
    "aggregate_by_supplier",
    "fetch_tender_document",
    "flag_single_bid_awards",
    "get_budget",
    "get_funding_source",
    "get_release_history",
    "get_tender",
    "list_bid_statistics",
    "list_enquiries",
    "list_lots",
    "list_tender_documents",
    "search_budgets",
    "search_contract_notices",
    "search_plans",
    "search_tenders",
    "search_tenders_deep",
  ]);
  for (const t of tools) {
    assert.ok(t.outputSchema, `${t.name} must have outputSchema`);
    assert.ok(t.annotations, `${t.name} must have annotations`);
  }
  // Aggregations + flags + reads are read-only.
  for (const name of ["aggregate_by_buyer", "aggregate_by_supplier", "flag_single_bid_awards", "get_tender"]) {
    const t = tools.find((x) => x.name === name)!;
    assert.equal(t.annotations?.readOnlyHint, true, `${name} should be readOnly`);
  }
  // The fetch tool is the only non-read-only one.
  const fetch = tools.find((t) => t.name === "fetch_tender_document")!;
  assert.equal(fetch.annotations?.readOnlyHint, false);
  await client.close();
});

test("resource templates and static resources are wired", async () => {
  const client = await pair();
  const { resourceTemplates } = await client.listResourceTemplates();
  const uris = resourceTemplates.map((t) => t.uriTemplate).sort();
  assert.deepEqual(uris, [
    "mtender://budgets/{ocid}",
    "mtender://funding/{ocid}",
    "mtender://tenders/{ocid}",
    "mtender://tenders/{ocid}/releases",
  ]);
  // Static resources include the upstream-health + listings.
  const { resources } = await client.listResources();
  const statics = resources.map((r) => r.uri);
  assert.ok(statics.includes("mtender://upstream/health"));
  assert.ok(statics.includes("mtender://contract-notices/latest"));
  assert.ok(statics.includes("mtender://plans/latest"));
  assert.ok(statics.includes("mtender://budgets/latest"));
  await client.close();
});

test("prompts/list returns 8 procurement-investigation prompts", async () => {
  const client = await pair();
  const { prompts } = await client.listPrompts();
  const names = prompts.map((p) => p.name).sort();
  assert.deepEqual(names, [
    "analyze-procurement",
    "audit-supplier",
    "buyer-spend-overview",
    "compare-tenders",
    "enquiry-review",
    "lot-breakdown",
    "pipeline-overview",
    "single-bid-investigation",
  ]);
  await client.close();
});

test("get_tender returns lots, enquiries, modalities", async () => {
  const client = await pair();
  const r = await client.callTool({
    name: "get_tender",
    arguments: { ocid: "ocds-b3wdp1-MD-1613996912600" },
  });
  assert.equal(r.isError, undefined);
  const sc = r.structuredContent as {
    lots: unknown[];
    enquiries: Array<{ answer?: string }>;
    procurementMethodModalities: string[];
    hasElectronicAuction: boolean;
  };
  assert.ok(sc.lots.length > 0, "must surface lots");
  assert.ok(sc.enquiries.length > 0, "must surface enquiries (public Q&A)");
  assert.ok(sc.enquiries.some((e) => e.answer && e.answer.length > 0), "enquiries must include answers");
  assert.ok(sc.procurementMethodModalities.includes("electronicAuction"));
  assert.equal(sc.hasElectronicAuction, true);
  await client.close();
});

test("upstream-health resource reports UP", async () => {
  const client = await pair();
  const r = await client.readResource({ uri: "mtender://upstream/health" });
  const body = JSON.parse(r.contents[0]!.text as string);
  assert.equal(body.status, "UP");
  await client.close();
});

test("fetch_tender_document on a scanned PDF returns image content blocks", async () => {
  const client = await pair();
  const r = await client.callTool({
    name: "fetch_tender_document",
    arguments: {
      documentUrl:
        "https://storage.mtender.gov.md/get/8b311b93-8092-4098-ae1f-d03d65d7fbe7-1614090797608",
      mode: "auto",
    },
  });
  assert.equal(r.isError, undefined);
  const sc = r.structuredContent as { scanned: boolean; imageCount: number; pages?: number };
  assert.equal(sc.scanned, true, "Canon-scanned tender PDF must be detected as scanned");
  assert.ok(sc.imageCount >= 1, "scanned PDFs must yield image content blocks");
  // mode=text suppresses images even on scanned PDFs.
  const r2 = await client.callTool({
    name: "fetch_tender_document",
    arguments: {
      documentUrl:
        "https://storage.mtender.gov.md/get/8b311b93-8092-4098-ae1f-d03d65d7fbe7-1614090797608",
      mode: "text",
    },
  });
  const sc2 = r2.structuredContent as { imageCount: number };
  assert.equal(sc2.imageCount, 0, "mode=text must not emit image blocks");
  await client.close();
});

test("contract-notices, plans, budgets listings each return entries", async () => {
  const client = await pair();
  for (const uri of [
    "mtender://contract-notices/latest",
    "mtender://plans/latest",
    "mtender://budgets/latest",
  ]) {
    const r = await client.readResource({ uri });
    const arr = JSON.parse(r.contents[0]!.text as string);
    assert.ok(Array.isArray(arr) && arr.length > 0, `${uri} must return entries`);
  }
  await client.close();
});

test("get_tender compiles full record (items, parties, awards) — the v1 fix", async () => {
  const client = await pair();
  const r = await client.callTool({
    name: "get_tender",
    arguments: { ocid: "ocds-b3wdp1-MD-1613996912600" },
  });
  assert.equal(r.isError, undefined);
  const sc = r.structuredContent as {
    ocid: string;
    items: unknown[];
    parties: unknown[];
    awards: unknown[];
    documents: unknown[];
  };
  assert.equal(sc.ocid, "ocds-b3wdp1-MD-1613996912600");
  assert.ok(sc.items.length > 0, "must have items (legacy returned empty)");
  assert.ok(sc.parties.length > 0, "must have parties (legacy returned empty)");
  assert.ok(sc.awards.length > 0, "must have awards (legacy returned empty)");
  assert.ok(sc.documents.length > 0, "must have documents");
  await client.close();
});

test("get_release_history returns chronological releases with tags", async () => {
  const client = await pair();
  const r = await client.callTool({
    name: "get_release_history",
    arguments: { ocid: "ocds-b3wdp1-MD-1613996912600" },
  });
  assert.equal(r.isError, undefined);
  const sc = r.structuredContent as { releases: Array<{ tag: string[] }> };
  assert.ok(sc.releases.length > 0);
  for (const rel of sc.releases) assert.ok(rel.tag.length >= 0);
  await client.close();
});

test("list_tender_documents enumerates docs across releases", async () => {
  const client = await pair();
  const r = await client.callTool({
    name: "list_tender_documents",
    arguments: { ocid: "ocds-b3wdp1-MD-1613996912600" },
  });
  assert.equal(r.isError, undefined);
  const sc = r.structuredContent as { documents: Array<{ url?: string; scope: string }> };
  assert.ok(sc.documents.length > 0);
  await client.close();
});

test("get_tender with malformed OCID returns tool error (not throw)", async () => {
  const client = await pair();
  const r = await client.callTool({ name: "get_tender", arguments: { ocid: "not-an-ocid" } });
  assert.equal(r.isError, true);
  await client.close();
});

test("search_tenders defaults to last 30 days and returns resource_link blocks", async () => {
  const client = await pair();
  const r = await client.callTool({ name: "search_tenders", arguments: { limit: 2 } });
  assert.equal(r.isError, undefined);
  const links = (r.content as Array<{ type: string }>).filter((c) => c.type === "resource_link");
  assert.equal(links.length, 2);
  await client.close();
});

test("aggregate_by_buyer scans recent tenders and returns ranked rows", async () => {
  const client = await pair();
  const r = await client.callTool({ name: "aggregate_by_buyer", arguments: { scanLatest: 10 } });
  assert.equal(r.isError, undefined);
  const sc = r.structuredContent as { rows: Array<{ buyer: string; tenders: number }>; scanned: number };
  assert.ok(sc.scanned > 0);
  // ranks should be descending by totalValue
  for (let i = 1; i < sc.rows.length; i++) {
    assert.ok(
      (sc.rows[i - 1] as any).totalValue >= (sc.rows[i] as any).totalValue,
      "rows must be sorted descending",
    );
  }
  await client.close();
});

test("completion/complete suggests OCIDs for the tender template", async () => {
  const client = await pair();
  const r = await client.complete({
    ref: { type: "ref/resource", uri: "mtender://tenders/{ocid}" },
    argument: { name: "ocid", value: "ocds-" },
  });
  assert.ok(r.completion.values.length > 0);
  for (const v of r.completion.values) assert.match(v, /^ocds-/);
  await client.close();
});
