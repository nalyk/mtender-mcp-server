import { extractText, extractImages, getMeta, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";
import sharp from "sharp";

const MAX_DOC_BYTES = 25 * 1024 * 1024; // 25 MiB safety cap on the input
const MAX_IMAGE_PAGES = 20;             // never return more than 20 page-images
const PAGE_JPEG_QUALITY = 78;           // good text legibility, ~300-500 KB/page

export type ExtractMode = "auto" | "text" | "image";

export interface ExtractedPart {
  type: "text" | "image";
  text?: string;
  imageBase64?: string;
  mimeType?: string;
  pageNumber?: number;
}

export interface ExtractedDoc {
  parts: ExtractedPart[];
  pages?: number;
  contentType: string;
  scanned: boolean;
  // For backwards compatibility with v3 callers / tests:
  text: string;
}

/**
 * Extract a document into a multi-modal envelope:
 *   - For native-text PDFs: text part (flat string).
 *   - For scanned PDFs (image-based, common in Moldovan procurement docs):
 *     embedded page-images returned as JPEG-encoded `image` parts. The host's
 *     vision-capable LLM does the OCR — language-agnostic by definition,
 *     covers Romanian / Russian / English / mixed without local OCR infra.
 *   - For DOCX: tables-aware HTML → Markdown conversion via mammoth.
 *   - For text/*: UTF-8 decode.
 *
 * `mode` lets callers force text-only or image-only extraction.
 *  Defaults to "auto" — text first, fall back to images if extraction looks
 *  like garbage.
 */
export async function extractDocument(
  buffer: Buffer,
  contentType: string,
  mode: ExtractMode = "auto",
): Promise<ExtractedDoc> {
  if (buffer.byteLength > MAX_DOC_BYTES) {
    throw new Error(
      `Document too large: ${buffer.byteLength} bytes (cap ${MAX_DOC_BYTES})`,
    );
  }
  const ct = contentType.toLowerCase();

  if (ct.includes("application/pdf")) return extractPdf(buffer, mode);
  if (
    ct.includes("application/msword") ||
    ct.includes("openxmlformats-officedocument") ||
    ct.includes("application/vnd.openxmlformats")
  ) {
    return extractDocx(buffer, ct);
  }
  if (ct.startsWith("text/")) {
    const text = clean(buffer.toString("utf8"));
    return {
      parts: [{ type: "text", text }],
      contentType: ct,
      scanned: false,
      text,
    };
  }
  throw new Error(`Unsupported document type: ${contentType}`);
}

async function extractPdf(buffer: Buffer, mode: ExtractMode): Promise<ExtractedDoc> {
  // Share a single pdf.js document proxy across text + image extraction so we
  // don't re-parse the PDF (and avoid pdf.js worker postMessage issues with
  // transferable image buffers when the document is reopened per call).
  const data = new Uint8Array(buffer);
  const proxy = await getDocumentProxy(data);
  const meta = await getMeta(proxy).catch(() => null);
  const t = await extractText(proxy, { mergePages: true });
  const text = clean(t.text);
  const totalPages = t.totalPages;
  const density = text.length / Math.max(buffer.byteLength, 1);
  const producer = `${meta?.info?.Producer ?? ""} ${meta?.info?.Creator ?? ""}`.toLowerCase();
  const scannerSignals = [
    "canon", "hp scan", "scanjet", "scansnap", "epson", "xerox", "kyocera",
    "samsung scx", "ricoh", "brother", "konica", "lexmark", "image conversion",
    "gimp", "imagemagick", "tiff", "kodak",
  ];
  const isScannerOutput = scannerSignals.some((s) => producer.includes(s));

  // Romanian uses these diacritics constantly. Their total absence in a
  // multi-page document where the text otherwise looks "long enough" is a
  // strong signal that the text stream is broken (scanned PDF with bad CMap).
  const diacritics = (text.match(/[ăâîșțĂÂÎȘȚşţŞŢ]/g) ?? []).length;
  const diacriticsPerKB = (diacritics / Math.max(text.length, 1)) * 1000;

  // Heuristic decision tree, most-confident first:
  //   1) Producer is a known scanner brand AND density is low → scanned.
  //   2) Char-per-byte density < 0.005 → almost certainly scanned.
  //   3) Multi-page doc with extracted text but ZERO Romanian diacritics in
  //      a substantial body (>2k chars) → broken character map, treat as scan.
  //   4) Per-page text < 80 chars → essentially no text, scanned.
  const looksScanned =
    (isScannerOutput && density < 0.01) ||
    density < 0.005 ||
    (totalPages >= 2 && text.length > 2000 && diacriticsPerKB < 0.5) ||
    text.length < totalPages * 80;

  const wantImages = mode === "image" || (mode === "auto" && looksScanned);

  const parts: ExtractedPart[] = [];
  if (mode !== "image") parts.push({ type: "text", text });

  if (wantImages) {
    const pageCount = Math.min(totalPages, MAX_IMAGE_PAGES);
    for (let page = 1; page <= pageCount; page++) {
      const images = await extractImages(proxy, page).catch((e: Error) => {
        // Per-page failure shouldn't abort the whole extraction.
        // eslint-disable-next-line no-console
        return [] as Array<{ data: Uint8ClampedArray; width: number; height: number; channels: number; key: string }>;
      });
      for (const im of images) {
        if (!im?.data) continue;
        const channels = im.channels === 1 ? 1 : im.channels === 4 ? 4 : 3;
        // Copy the pixel buffer rather than aliasing it — avoids holding a
        // reference into pdf.js worker memory.
        const rgbCopy = Buffer.from(im.data);
        const jpeg = await sharp(rgbCopy, {
          raw: { width: im.width, height: im.height, channels },
        })
          .jpeg({ quality: PAGE_JPEG_QUALITY, mozjpeg: true })
          .toBuffer();
        parts.push({
          type: "image",
          imageBase64: jpeg.toString("base64"),
          mimeType: "image/jpeg",
          pageNumber: page,
        });
      }
    }
  }

  return {
    parts,
    pages: totalPages,
    contentType: meta?.info?.Producer ? `application/pdf (${meta.info.Producer.trim()})` : "application/pdf",
    scanned: looksScanned,
    text,
  };
}

async function extractDocx(buffer: Buffer, contentType: string): Promise<ExtractedDoc> {
  // convertToHtml preserves tables, lists, and inline images. We then convert
  // the HTML body to Markdown — tables survive as GFM tables.
  const html = await mammoth.convertToHtml(
    { buffer },
    {
      convertImage: mammoth.images.imgElement(async () => ({ src: "" })), // strip image src — we'd need to re-host
    },
  );
  const md = htmlToMarkdown(html.value);
  return {
    parts: [{ type: "text", text: md }],
    contentType,
    scanned: false,
    text: md,
  };
}

// Minimal, dependency-free HTML→Markdown for the small subset mammoth emits:
// p, br, strong, em, h1..h6, ul/ol/li, table/tr/th/td, a.
function htmlToMarkdown(html: string): string {
  let s = html;
  // Tables: convert each <table> to a GFM table.
  s = s.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_m, inner) => {
    const rows: string[][] = [];
    const trMatches = inner.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
    for (const trm of trMatches) {
      const cells: string[] = [];
      const cellRe = /<(t[hd])[^>]*>([\s\S]*?)<\/\1>/gi;
      let cm: RegExpExecArray | null;
      while ((cm = cellRe.exec(trm[1] ?? "")) !== null) {
        cells.push(stripTags(cm[2] ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim());
      }
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return "";
    const widths = rows[0]!.length;
    const header = rows[0]!.join(" | ");
    const sep = Array(widths).fill("---").join(" | ");
    const body = rows.slice(1).map((r) => r.join(" | ")).join("\n");
    return `\n\n| ${header} |\n| ${sep} |\n${body ? body.split("\n").map((l) => `| ${l} |`).join("\n") : ""}\n\n`;
  });
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lv, c) => `\n\n${"#".repeat(Number(lv))} ${stripTags(c)}\n\n`);
  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, c) => `**${stripTags(c)}**`);
  s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, c) => `*${stripTags(c)}*`);
  s = s.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, c) => `[${stripTags(c)}](${href})`);
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, c) => `- ${stripTags(c)}\n`);
  s = s.replace(/<\/?(ul|ol)[^>]*>/gi, "\n");
  s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_m, c) => `\n${stripTags(c)}\n`);
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = stripTags(s);
  return clean(decodeEntities(s));
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}

function clean(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
