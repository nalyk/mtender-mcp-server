import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mapBounded } from "../concurrency.js";
import { compileTender, listTenders } from "../api/mtender.js";
import type { TenderSummary } from "../schemas.js";

export const READ_ONLY = {
  readOnlyHint: true,
  openWorldHint: true,
  idempotentHint: true,
} as const;

export interface ToolCtx {
  signal?: AbortSignal;
  // Looser than the SDK's `(n: ServerNotification) => Promise<void>` so the
  // helper can be called from any tool handler without casting; the SDK
  // discriminates on `method` at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendNotification?: (n: any) => Promise<void>;
  _meta?: { progressToken?: string | number };
}

/** Progress notification (numerical). Honors the optional progressToken
 *  on the originating request; no-op when the client did not request it. */
export async function progress(
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

/** Logging notification (textual / structured). Honors the `logging: {}`
 *  capability declared on the server. Failures are swallowed — logging is
 *  never load-bearing for tool correctness. */
export async function logEvent(
  server: McpServer,
  level: "debug" | "info" | "notice" | "warning" | "error",
  data: Record<string, unknown>,
): Promise<void> {
  try {
    await server.sendLoggingMessage({ level, data, logger: "mtender" });
  } catch {
    // sendLoggingMessage rejects if the client never subscribed — non-fatal.
  }
}

export function tenderLink(
  ocid: string,
  name?: string,
  description?: string,
): {
  type: "resource_link";
  uri: string;
  name: string;
  description?: string;
  mimeType: string;
} {
  return {
    type: "resource_link",
    uri: `mtender://tenders/${ocid}`,
    name: name ?? ocid,
    ...(description ? { description } : {}),
    mimeType: "application/json",
  };
}

/** Scan the latest N tenders and compile each. Used by aggregators and red-flag
 *  scanners. Returns summaries (null on per-tender error so the scan continues). */
export async function scanLatestSummaries(
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

/** Render a TenderSummary as a compact human-readable plaintext block.
 *  Format preserved verbatim from the pre-modular-split src/tools.ts. */
export function renderTender(t: TenderSummary): string {
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
