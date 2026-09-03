import assert from "node:assert/strict";
import test from "node:test";

import { assertPublicTargetUrl, createPublicFetch } from "../runner/public-target.mjs";

test("public target validation accepts an HTTPS name only when DNS resolves publicly", async () => {
  const lookups = [];
  const result = await assertPublicTargetUrl("https://example.com/people/alice", {
    lookup: async (hostname, options) => {
      lookups.push({ hostname, options });
      return [{ address: "93.184.216.34", family: 4 }];
    }
  });

  assert.equal(result.href, "https://example.com/people/alice");
  assert.deepEqual(lookups, [{ hostname: "example.com", options: { all: true, verbatim: true } }]);
});

test("public target validation strips fragments and rejects credential-shaped query parameters", async () => {
  const options = { lookup: async () => [{ address: "93.184.216.34", family: 4 }] };
  const result = await assertPublicTargetUrl("https://example.com/people/alice#access_token=fragment-secret", options);

  assert.equal(result.href, "https://example.com/people/alice");
  await assert.rejects(
    () => assertPublicTargetUrl("https://example.com/people/alice?api_key=query-secret", options),
    /query parameter.*credential/i
  );
  await assert.rejects(
    () => assertPublicTargetUrl("https://example.com/people/alice?accessToken=query-secret", options),
    /query parameter.*credential/i
  );
});

test("public target validation rejects non-HTTPS, embedded credentials and local names before DNS", async () => {
  let lookupCount = 0;
  const options = {
    lookup: async () => {
      lookupCount += 1;
      return [{ address: "93.184.216.34", family: 4 }];
    }
  };

  await assert.rejects(() => assertPublicTargetUrl("http://example.com/alice", options), /HTTPS/i);
  await assert.rejects(() => assertPublicTargetUrl("https://alice:secret@example.com/", options), /credentials/i);
  await assert.rejects(() => assertPublicTargetUrl("https://localhost/alice", options), /public host/i);
  await assert.rejects(() => assertPublicTargetUrl("https://localhost./alice", options), /public host/i);
  await assert.rejects(() => assertPublicTargetUrl("https://printer.local/alice", options), /public host/i);
  await assert.rejects(() => assertPublicTargetUrl("https://printer.local./alice", options), /public host/i);
  await assert.rejects(() => assertPublicTargetUrl("https://intranet/alice", options), /public host/i);
  assert.equal(lookupCount, 0);
});

test("public target validation blocks non-public IP literals", async () => {
  const blocked = [
    "https://127.0.0.1/",
    "https://2130706433/",
    "https://10.2.3.4/",
    "https://100.64.0.1/",
    "https://169.254.169.254/latest/meta-data/",
    "https://172.16.1.2/",
    "https://192.168.1.2/",
    "https://[::1]/",
    "https://[fc00::1]/",
    "https://[fe80::1]/",
    "https://[::ffff:127.0.0.1]/"
  ];

  for (const value of blocked) {
    await assert.rejects(() => assertPublicTargetUrl(value), /public IP address/i, value);
  }

  const publicIpv4 = await assertPublicTargetUrl("https://93.184.216.34/profile");
  const publicIpv6 = await assertPublicTargetUrl("https://[2001:4860:4860::8888]/profile");
  assert.equal(publicIpv4.hostname, "93.184.216.34");
  assert.equal(publicIpv6.hostname, "[2001:4860:4860::8888]");
});

test("public target validation rejects host names resolving to any non-public address", async () => {
  await assert.rejects(
    () => assertPublicTargetUrl("https://rebound.example/profile", {
      lookup: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "169.254.169.254", family: 4 }
      ]
    }),
    /resolved to a non-public IP address/i
  );

  await assert.rejects(
    () => assertPublicTargetUrl("https://empty.example/profile", { lookup: async () => [] }),
    /did not resolve/i
  );
});

test("public fetch refuses a redirect to a private address before requesting it", async () => {
  const requested = [];
  const publicFetch = createPublicFetch({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async (url, options) => {
      requested.push({ url: String(url), redirect: options.redirect });
      return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/admin" } });
    }
  });

  await assert.rejects(() => publicFetch("https://example.com/profile"), /public IP address/i);
  assert.deepEqual(requested, [{ url: "https://example.com/profile", redirect: "manual" }]);
});

test("public fetch removes credentials before following a cross-origin redirect", async () => {
  const requests = [];
  const publicFetch = createPublicFetch({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), headers: new Headers(options.headers) });
      if (requests.length === 1) {
        return new Response(null, { status: 302, headers: { location: "https://other.example/result" } });
      }
      return new Response("public result", { status: 200 });
    }
  });

  const response = await publicFetch("https://example.com/profile", {
    headers: { authorization: "Bearer secret", cookie: "session=secret", "x-public-client": "ppr" }
  });

  assert.equal(await response.text(), "public result");
  assert.equal(requests[1].headers.has("authorization"), false);
  assert.equal(requests[1].headers.has("cookie"), false);
  assert.equal(requests[1].headers.get("x-public-client"), "ppr");
});

test("public fetch never forwards URL fragments", async () => {
  const requested = [];
  const publicFetch = createPublicFetch({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async (url) => {
      requested.push(String(url));
      return new Response("public result", { status: 200 });
    }
  });

  await publicFetch("https://example.com/profile#session=fragment-secret");
  assert.deepEqual(requested, ["https://example.com/profile"]);
});

test("public fetch is read-only", async () => {
  let fetchCount = 0;
  const publicFetch = createPublicFetch({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response("unexpected");
    }
  });

  await assert.rejects(
    () => publicFetch("https://example.com/profile", { method: "POST", body: "data" }),
    /read-only/i
  );
  assert.equal(fetchCount, 0);
});

test("public fetch aborts a response that exceeds its overall deadline", async () => {
  const publicFetch = createPublicFetch({
    timeoutMs: 20,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason ?? new Error("aborted")), { once: true });
    })
  });

  await assert.rejects(() => publicFetch("https://example.com/profile"), /deadline|timeout|abort/i);
});
