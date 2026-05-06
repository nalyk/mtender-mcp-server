import { request, Agent, errors as undiciErrors } from "undici";
import { logger } from "../logger.js";
import { TtlLru } from "../cache.js";
import { mapBounded } from "../concurrency.js";
import { pinnedLookup, type ValidatedDocUrl } from "../ssrf.js";
import {
  TenderListItem,
  TenderSummary,
  BudgetSummary,
  FundingSummary,
  ReleaseHistoryItem,
} from "../schemas.js";

export const MTENDER_API_BASE_URL = "https://public.mtender.gov.md";
const REQUEST_TIMEOUT_MS = 30_000;
const PACKAGE_FETCH_CONCURRENCY = 4;
const CACHE_TTL_MS = 10 * 60_000;

// Connection pooling: undici Agent with bounded keep-alive sockets.
const agent = new Agent({
  pipelining: 1,
  connections: 8,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
});

// Caches: small + per-resource. Keyed by full URL or OCID.
const recordCache = new TtlLru<TenderRecordResponse>(500, CACHE_TTL_MS);
const packageCache = new TtlLru<ReleasePackage>(2_000, CACHE_TTL_MS);
const compiledCache = new TtlLru<{ summary: TenderSummary; releases: any[] }>(500, CACHE_TTL_MS);
const budgetCache = new TtlLru<BudgetSummary>(500, CACHE_TTL_MS);
const fundingCache = new TtlLru<FundingSummary>(500, CACHE_TTL_MS);

async function getJson<T = unknown>(url: string, signal?: AbortSignal): Promise<T> {
  const started = Date.now();
  const r = await retry(async () =>
    request(url, {
      method: "GET",
      bodyTimeout: REQUEST_TIMEOUT_MS,
      headersTimeout: REQUEST_TIMEOUT_MS,
      dispatcher: agent,
      signal,
    }),
  );
  const ms = Date.now() - started;
  if (r.statusCode >= 400) {
    const body = await r.body.text();
    logger.warn({ url, status: r.statusCode, ms }, "mtender upstream error");
    throw new Error(`MTender ${r.statusCode}: ${body.slice(0, 500)}`);
  }
  const json = (await r.body.json()) as T;
  logger.debug({ url, status: r.statusCode, ms }, "mtender ok");
  return json;
}

async function retry<T>(fn: () => Promise<T>): Promise<T> {
  const max = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const transient =
        e instanceof undiciErrors.SocketError ||
        e instanceof undiciErrors.HeadersTimeoutError ||
        e instanceof undiciErrors.BodyTimeoutError ||
        e instanceof undiciErrors.ConnectTimeoutError;
      if (!transient || attempt === max) throw e;
      const backoffMs = 200 * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

interface RawListResponse {
  data: Array<{ ocid: string; date: string }>;
  offset?: string;
}

interface TenderRecordResponse {
  packages: string[];
  records: Array<{ ocid: string; compiledRelease: any }>;
  actualReleases?: Array<{ ocid: string; uri: string }>;
}

interface ReleasePackage {
  releases: any[];
  publishedDate?: string;
}

type ListPath = "/tenders/" | "/tenders/cn" | "/tenders/plan" | "/budgets";

export interface ListOpts {
  offset?: string;
  /** Upstream page size. MTender accepts `limit`; the upstream default is
   *  ~100 and capped well above 200 in practice. Always sent through; the
   *  caller's slice is kept as a defense in depth. */
  limit?: number;
  signal?: AbortSignal;
}

async function listFrom(
  path: ListPath,
  opts: ListOpts,
): Promise<{ data: TenderListItem[]; nextOffset?: string }> {
  const offset =
    opts.offset ?? new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
  const params = new URLSearchParams({ offset });
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const url = `${MTENDER_API_BASE_URL}${path}?${params.toString()}`;
  const raw = await getJson<RawListResponse>(url, opts.signal);
  return {
    data: (raw.data ?? []).map((d) => TenderListItem.parse(d)),
    nextOffset: raw.offset,
  };
}

export async function listContractNotices(
  opts: ListOpts,
): Promise<{ data: TenderListItem[]; nextOffset?: string }> {
  return listFrom("/tenders/cn", opts);
}

export async function listPlans(
  opts: ListOpts,
): Promise<{ data: TenderListItem[]; nextOffset?: string }> {
  return listFrom("/tenders/plan", opts);
}

export async function listBudgets(
  opts: ListOpts,
): Promise<{ data: TenderListItem[]; nextOffset?: string }> {
  return listFrom("/budgets", opts);
}

interface UpstreamInfo {
  build?: { version?: string; time?: string };
}
export async function getUpstreamHealth(
  signal?: AbortSignal,
): Promise<{ status: string; build?: { version?: string; time?: string } }> {
  const [health, info] = await Promise.all([
    getJson<{ status: string }>(`${MTENDER_API_BASE_URL}/actuator/health`, signal),
    getJson<UpstreamInfo>(`${MTENDER_API_BASE_URL}/actuator/info`, signal).catch(
      () => ({}) as UpstreamInfo,
    ),
  ]);
  return { status: health.status, build: info.build };
}

export async function listTenders(
  opts: ListOpts,
): Promise<{ data: TenderListItem[]; nextOffset?: string }> {
  // Default offset = 30 days ago. The MTender API is paginated ascending by
  // date; without an offset it returns the oldest records (2018+).
  return listFrom("/tenders/", opts);
}

async function getTenderRecord(ocid: string, signal?: AbortSignal): Promise<TenderRecordResponse> {
  const url = `${MTENDER_API_BASE_URL}/tenders/${encodeURIComponent(ocid)}`;
  const cached = recordCache.get(url);
  if (cached) return cached;
  const data = await getJson<TenderRecordResponse>(url, signal);
  recordCache.set(url, data);
  return data;
}

async function getReleasePackage(packageUrl: string, signal?: AbortSignal): Promise<ReleasePackage> {
  // packages array uses http://; upgrade to https.
  const upgraded = packageUrl.replace(/^http:\/\//, "https://");
  const cached = packageCache.get(upgraded);
  if (cached) return cached;
  const data = await getJson<ReleasePackage>(upgraded, signal);
  packageCache.set(upgraded, data);
  return data;
}

// Fetch every package in `packages[]` (concurrency-bounded) and merge their
// releases into a single compiled view. Later releases (by `date`) override
// earlier ones field-by-field. This is the canonical OCDS "compile a record"
// pattern — MTender's own compiledRelease ships only basic metadata.
export async function compileTender(
  ocid: string,
  opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => Promise<void> } = {},
): Promise<{
  summary: TenderSummary;
  releases: any[];
}> {
  const cached = compiledCache.get(ocid);
  if (cached) return cached;

  const record = await getTenderRecord(ocid, opts.signal);
  const packageUrls = record.packages ?? [];
  const packs = await mapBounded(
    packageUrls,
    PACKAGE_FETCH_CONCURRENCY,
    (url) => getReleasePackage(url, opts.signal),
    opts.onProgress,
  );

  const allReleases: any[] = [];
  for (const pack of packs) for (const rel of pack.releases ?? []) allReleases.push(rel);
  allReleases.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const merged: any = {};
  for (const rel of allReleases) {
    for (const k of Object.keys(rel)) {
      // Don't shallow-overwrite arrays of objects (awards/contracts/parties/items)
      // — instead, union by id and let later releases override.
      if (Array.isArray(rel[k]) && Array.isArray(merged[k])) {
        merged[k] = unionById(merged[k], rel[k]);
      } else {
        merged[k] = rel[k];
      }
    }
  }

  const summary = TenderSummary.parse({
    ocid,
    title: merged.tender?.title,
    description: merged.tender?.description,
    status: merged.tender?.status,
    statusDetails: merged.tender?.statusDetails,
    procurementMethod: merged.tender?.procurementMethod,
    mainProcurementCategory: merged.tender?.mainProcurementCategory,
    procurementMethodDetails: merged.tender?.procurementMethodDetails,
    value: numericValue(merged.tender?.value),
    minValue: numericValue(merged.tender?.minValue),
    tenderPeriod: periodFrom(merged.tender?.tenderPeriod),
    enquiryPeriod: periodFrom(merged.tender?.enquiryPeriod),
    procurementMethodModalities: merged.tender?.procurementMethodModalities ?? [],
    hasElectronicAuction: !!merged.tender?.electronicAuctions,
    lots: (merged.tender?.lots ?? []).map((l: any) => ({
      id: l.id,
      title: l.title,
      description: l.description,
      status: l.status,
      statusDetails: l.statusDetails,
      value: numericValue(l.value),
      contractPeriod: periodFrom(l.contractPeriod),
      placeOfPerformance: l.placeOfPerformance,
    })),
    enquiries: (merged.tender?.enquiries ?? []).map((e: any) => ({
      id: e.id,
      date: e.date,
      title: e.title,
      description: e.description,
      answer: e.answer,
      dateAnswered: e.dateAnswered,
    })),
    bidStatistics: (merged.bids?.statistics ?? []).map((s: any) => ({
      id: s.id,
      measure: s.measure,
      value: typeof s.value === "number" ? s.value : Number(s.value),
      date: s.date,
      notes: s.notes,
      relatedLot: s.relatedLot,
    })),
    buyer: merged.buyer?.name ?? findPartyByRole(merged.parties, "buyer")?.name,
    parties: (merged.parties ?? []).map((p: any) => ({
      id: p.id,
      name: p.name,
      roles: p.roles ?? [],
      identifier: p.identifier?.id,
      address: p.address ? { country: p.address.countryName, locality: p.address.locality } : undefined,
    })),
    items: (merged.tender?.items ?? []).map((it: any) => ({
      id: it.id,
      description: it.description,
      classification: it.classification
        ? { scheme: it.classification.scheme, id: it.classification.id, description: it.classification.description }
        : undefined,
      quantity: it.quantity,
      unit: it.unit ? { name: it.unit.name, value: numericValue(it.unit.value) } : undefined,
      relatedLot: it.relatedLot,
    })),
    documents: (merged.tender?.documents ?? []).map((d: any) => ({
      id: d.id,
      title: d.title,
      documentType: d.documentType,
      url: d.url,
      datePublished: d.datePublished,
      format: d.format,
    })),
    amendments: (merged.tender?.amendments ?? []).map((a: any) => ({
      id: a.id,
      date: a.date,
      rationale: a.rationale,
      description: a.description,
    })),
    awards: (merged.awards ?? []).map((a: any) => ({
      id: a.id,
      title: a.title,
      status: a.status,
      date: a.date,
      value: numericValue(a.value),
      suppliers: (a.suppliers ?? []).map((s: any) => ({ id: s.id, name: s.name })),
      relatedLots: a.relatedLots ?? [],
      documents: shortDocs(a.documents),
    })),
    contracts: (merged.contracts ?? []).map((c: any) => ({
      id: c.id,
      awardID: c.awardID,
      title: c.title,
      status: c.status,
      value: numericValue(c.value),
      dateSigned: c.dateSigned,
      period: periodFrom(c.period),
      documents: shortDocs(c.documents),
    })),
    relatedProcesses: (merged.relatedProcesses ?? []).map((rp: any) => ({
      id: rp.id,
      relationship: rp.relationship ?? [],
      identifier: rp.identifier,
      uri: rp.uri,
    })),
  });

  const compiled = { summary, releases: allReleases };
  compiledCache.set(ocid, compiled);
  return compiled;
}

export async function getReleaseHistory(
  ocid: string,
  signal?: AbortSignal,
): Promise<ReleaseHistoryItem[]> {
  const { releases } = await compileTender(ocid, { signal });
  return releases.map((r) =>
    ReleaseHistoryItem.parse({
      releaseId: r.id,
      date: r.date,
      tag: r.tag ?? [],
      uri: r.uri,
    }),
  );
}

function unionById<T extends { id?: string | number }>(a: T[], b: T[]): T[] {
  const byId = new Map<string, T>();
  for (const x of a) byId.set(String(x.id ?? Math.random()), x);
  for (const x of b) byId.set(String(x.id ?? Math.random()), x);
  return [...byId.values()];
}

function numericValue(v: any): { amount: number; currency: string } | undefined {
  if (!v || v.amount === undefined) return undefined;
  return { amount: Number(v.amount), currency: String(v.currency ?? "MDL") };
}

function periodFrom(p: any): { startDate?: string; endDate?: string } | undefined {
  if (!p) return undefined;
  return { startDate: p.startDate, endDate: p.endDate };
}

function findPartyByRole(parties: any[] | undefined, role: string): any | undefined {
  return (parties ?? []).find((p) => (p.roles ?? []).includes(role));
}

// Award/contract documents only carry id/title/url in the summary shape.
function shortDocs(
  docs: any[] | undefined,
): Array<{ id?: string; title?: string; url?: string }> {
  return (docs ?? []).map((d: any) => ({ id: d.id, title: d.title, url: d.url }));
}

export async function getBudget(ocid: string, signal?: AbortSignal): Promise<BudgetSummary> {
  const cached = budgetCache.get(ocid);
  if (cached) return cached;
  const url = `${MTENDER_API_BASE_URL}/budgets/${encodeURIComponent(ocid)}/${encodeURIComponent(ocid)}`;
  const raw = await getJson<{ releases?: Array<{ planning?: { budget?: any } }> }>(url, signal);
  const b = raw.releases?.[0]?.planning?.budget;
  const v = BudgetSummary.parse({
    ocid,
    budgetId: b?.id,
    description: b?.description,
    amount: numericValue(b?.amount),
    project: b?.project,
    projectID: b?.projectID,
    period: periodFrom(b?.period),
  });
  budgetCache.set(ocid, v);
  return v;
}

export async function getFundingSource(
  ocid: string,
  signal?: AbortSignal,
): Promise<FundingSummary> {
  const cached = fundingCache.get(ocid);
  if (cached) return cached;
  const parts = ocid.split("-");
  const last = parts[parts.length - 1];
  if (!last) throw new Error(`Malformed OCID: ${ocid}`);
  const fundingSourceId = `${parts.slice(0, -1).join("-")}-FS-${last}`;
  const url = `${MTENDER_API_BASE_URL}/budgets/${encodeURIComponent(ocid)}/${encodeURIComponent(fundingSourceId)}`;
  const raw = await getJson<{
    releases?: Array<{ planning?: { budget?: any }; parties?: any[] }>;
  }>(url, signal);
  const release = raw.releases?.[0];
  const b = release?.planning?.budget;
  const v = FundingSummary.parse({
    ocid,
    fundingSourceId,
    amount: numericValue(b?.amount),
    description: b?.description,
    period: periodFrom(b?.period),
    parties: (release?.parties ?? []).map((p: any) => ({
      name: p.name ?? "Unnamed",
      roles: p.roles ?? [],
    })),
  });
  fundingCache.set(ocid, v);
  return v;
}

export async function fetchDocument(
  validated: ValidatedDocUrl,
  signal?: AbortSignal,
): Promise<{ buffer: Buffer; contentType: string; filename?: string }> {
  // Per-fetch dispatcher with `connect.lookup` pinned to the IP we already
  // validated as non-private. Closes the TOCTOU window between
  // `validateDocumentUrl`'s `dns.lookup` and the actual TCP connect — undici
  // would otherwise re-resolve DNS independently. SNI / TLS cert validation
  // still uses the URL hostname (`storage.mtender.gov.md`).
  const pinnedAgent = new Agent({
    pipelining: 1,
    connections: 1,
    keepAliveTimeout: 5_000,
    keepAliveMaxTimeout: 10_000,
    connect: { lookup: pinnedLookup(validated.resolvedIp) },
  });
  try {
    const r = await retry(() =>
      request(validated.url.href, {
        method: "GET",
        bodyTimeout: REQUEST_TIMEOUT_MS,
        headersTimeout: REQUEST_TIMEOUT_MS,
        dispatcher: pinnedAgent,
        signal,
      }),
    );
    if (r.statusCode >= 400) {
      throw new Error(`Document fetch failed: HTTP ${r.statusCode}`);
    }
    const contentType = String(r.headers["content-type"] ?? "application/octet-stream");
    const cd = r.headers["content-disposition"];
    let filename: string | undefined;
    if (typeof cd === "string") {
      const utf8 = cd.match(/filename\*=utf-8''([^;]+)/i);
      const plain = cd.match(/filename="?([^";]+)"?/i);
      filename = utf8 ? decodeURIComponent(utf8[1]!) : plain ? plain[1] : undefined;
    }
    const buffer = Buffer.from(await r.body.arrayBuffer());
    return { buffer, contentType, filename };
  } finally {
    await pinnedAgent.close().catch(() => undefined);
  }
}

export function cacheStats(): Record<string, number> {
  return {
    record: recordCache.size(),
    package: packageCache.size(),
    compiled: compiledCache.size(),
    budget: budgetCache.size(),
    funding: fundingCache.size(),
  };
}
