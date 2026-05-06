import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchDocument } from "../api/mtender.js";
import { validateDocumentUrl } from "../ssrf.js";
import { extractDocument } from "../document.js";
import { logger } from "../logger.js";
import { progress, logEvent } from "./_shared.js";

export function registerDocumentTools(server: McpServer): void {
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
        await logEvent(server, "info", {
          event: "scanned_pdf_detected",
          host: validated.url.hostname,
          pages: extracted.pages,
          imageCount: imageParts.length,
          contentType: extracted.contentType,
        });
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
