import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDocumentUrl, pinnedLookup } from "../src/ssrf.ts";

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

test("pinnedLookup returns the configured IPv4 address with family 4 regardless of hostname", async () => {
  const lookup = pinnedLookup("1.2.3.4");
  const { err, address, family } = await new Promise<{
    err: Error | null;
    address: unknown;
    family: number | undefined;
  }>((resolve) => {
    lookup("storage.mtender.gov.md", {}, (e, a, f) =>
      resolve({ err: e, address: a, family: f }),
    );
  });
  assert.equal(err, null);
  assert.equal(address, "1.2.3.4");
  assert.equal(family, 4);
});

test("pinnedLookup returns the configured IPv6 address with family 6", async () => {
  const lookup = pinnedLookup("2001:db8::1");
  const { err, address, family } = await new Promise<{
    err: Error | null;
    address: unknown;
    family: number | undefined;
  }>((resolve) => {
    lookup("anything", {}, (e, a, f) => resolve({ err: e, address: a, family: f }));
  });
  assert.equal(err, null);
  assert.equal(address, "2001:db8::1");
  assert.equal(family, 6);
});

test("pinnedLookup honors options.all by returning a single-entry address array", async () => {
  const lookup = pinnedLookup("203.0.113.7");
  const { err, address, family } = await new Promise<{
    err: Error | null;
    address: unknown;
    family: number | undefined;
  }>((resolve) => {
    lookup("anything", { all: true }, (e, a, f) =>
      resolve({ err: e, address: a, family: f }),
    );
  });
  assert.equal(err, null);
  assert.deepEqual(address, [{ address: "203.0.113.7", family: 4 }]);
  // family arg is irrelevant in the `all` form per Node's dns.lookup contract.
  assert.equal(family, 4);
});
