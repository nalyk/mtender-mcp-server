import { promises as dns } from "node:dns";
import net from "node:net";

const ALLOWED_DOC_HOST = "storage.mtender.gov.md";

// CIDR ranges that must NEVER be reached from an outbound MCP-server fetch.
// Includes IMDS (169.254.169.254) and all RFC1918/loopback/link-local space.
const BLOCKED_V4_CIDRS: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local incl. IMDS
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
];

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

function inV4Range(ip: string, network: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(network) & mask);
}

function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return BLOCKED_V4_CIDRS.some(([n, b]) => inV4Range(ip, n, b));
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    // IPv4-mapped IPv6
    const m = lower.match(/^::ffff:([0-9.]+)$/);
    if (m && net.isIPv4(m[1]!)) return BLOCKED_V4_CIDRS.some(([n, b]) => inV4Range(m[1]!, n, b));
  }
  return false;
}

export interface ValidatedDocUrl {
  url: URL;
  resolvedIp: string;
}

/**
 * Validate that a document URL targets the official MTender storage host AND
 * resolves to a public IP. Defends against:
 *   - URL parser bypasses (uses WHATWG URL)
 *   - DNS rebinding to RFC1918 / IMDS / loopback (blocks before fetch)
 *
 * The caller MUST use the returned `resolvedIp` (with `Host: storage.mtender.gov.md`)
 * to defeat TOCTOU rebind between validation and request.
 */
export async function validateDocumentUrl(input: string): Promise<ValidatedDocUrl> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Invalid URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }
  if (url.hostname !== ALLOWED_DOC_HOST) {
    throw new Error(`Host not allowed: ${url.hostname}`);
  }
  if (!url.pathname.startsWith("/get/")) {
    throw new Error(`Path not allowed: ${url.pathname}`);
  }

  const lookup = await dns.lookup(url.hostname, { all: false });
  if (isBlockedIp(lookup.address)) {
    throw new Error(`Resolved IP ${lookup.address} is in a blocked range`);
  }

  // Force https — we have already accepted only the official host.
  url.protocol = "https:";
  return { url, resolvedIp: lookup.address };
}
