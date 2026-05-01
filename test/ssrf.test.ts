import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDocumentUrl } from "../src/ssrf.ts";

test("rejects non-https/http schemes", async () => {
  await assert.rejects(() => validateDocumentUrl("file:///etc/passwd"), /Unsupported protocol/);
  await assert.rejects(() => validateDocumentUrl("javascript:alert(1)"), /Unsupported protocol/);
});

test("rejects wrong host", async () => {
  await assert.rejects(
    () => validateDocumentUrl("https://evil.example.com/get/1234-1"),
    /Host not allowed/,
  );
  // Userinfo trick: hostname is example.com despite the credentials.
  await assert.rejects(
    () =>
      validateDocumentUrl("https://storage.mtender.gov.md@evil.example.com/get/1234-1"),
    /Host not allowed/,
  );
});

test("rejects wrong path", async () => {
  await assert.rejects(
    () => validateDocumentUrl("https://storage.mtender.gov.md/admin/secret"),
    /Path not allowed/,
  );
});

test("accepts a valid storage URL and returns a public IP", async () => {
  const r = await validateDocumentUrl(
    "https://storage.mtender.gov.md/get/8e03c261-6f62-4e0f-87ea-2882afdf7f54-1682585742785",
  );
  assert.equal(r.url.hostname, "storage.mtender.gov.md");
  assert.equal(r.url.protocol, "https:");
  assert.ok(r.resolvedIp.length > 0);
});

test("upgrades http:// to https:// for the official host", async () => {
  const r = await validateDocumentUrl(
    "http://storage.mtender.gov.md/get/8e03c261-6f62-4e0f-87ea-2882afdf7f54-1682585742785",
  );
  assert.equal(r.url.protocol, "https:");
});
