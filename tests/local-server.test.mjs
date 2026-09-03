import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLocalServer } from "../server/local-server.mjs";
import { createResearchBrief } from "../website/lib/research-brief.mjs";

function request(port, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: requestPath,
      method: options.method ?? "GET",
      headers: { connection: "close", ...(options.headers ?? {}) }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppr-server-"));
  const websiteRoot = path.join(root, "website");
  const runRoot = path.join(root, "runs");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(websiteRoot, { recursive: true }));
  await writeFile(path.join(websiteRoot, "index.html"), "<!doctype html><title>Research</title>", "utf8");
  const received = [];
  const server = createLocalServer({
    websiteRoot,
    runRoot,
    async detectCapabilities() {
      return { checked_at: "2026-09-03T08:00:00.000Z", tools: {}, platforms: [], summary: { text: "Fixture capabilities ready." } };
    },
    async runProduct(brief, { outputDirectory }) {
      received.push(brief);
      await import("node:fs/promises").then(({ mkdir }) => mkdir(path.join(outputDirectory, "report"), { recursive: true }));
      await writeFile(path.join(outputDirectory, "report", "index.html"), "<!doctype html><title>Result</title>", "utf8");
      return { run_id: "run-fixture", status: "completed", targets: [] };
    },
    ...overrides
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, received, runRoot, websiteRoot, root };
}

test("the local site reports a real research engine and serves its static interface", async (t) => {
  const { port } = await fixture(t);
  const health = await request(port, "/api/health");
  const page = await request(port, "/");
  const capabilities = await request(port, "/api/capabilities");

  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).research, true);
  assert.equal(JSON.parse(health.body).local_only, true);
  assert.equal(JSON.parse(capabilities.body).capabilities.summary.text, "Fixture capabilities ready.");
  assert.equal(page.status, 200);
  assert.match(page.body, /Research/);
});

test("POST research invokes the product and exposes the generated private report locally", async (t) => {
  const { port, received } = await fixture(t);
  const brief = createResearchBrief({
    subjectName: "Ada Example",
    profileUrls: ["https://github.com/ada-example"],
    purpose: "self_audit",
    depth: "quick",
    modules: ["identity"]
  });
  const response = await request(port, "/api/research", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(brief)
  });

  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.run.status, "completed");
  assert.equal(received[0].subject.display_name, "Ada Example");
  assert.match(payload.report_url, /^\/runs\/run-fixture\/report\/index\.html$/);
  const report = await request(port, payload.report_url);
  assert.equal(report.status, 200);
  assert.match(report.body, /Result/);
});

test("the local site rejects malformed and oversized API input", async (t) => {
  const { port } = await fixture(t);
  const malformed = await request(port, "/api/research", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{"
  });
  const oversized = await request(port, "/api/research", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(1_100_000) },
    body: "{}"
  });

  assert.equal(malformed.status, 400);
  assert.equal(oversized.status, 413);
});

test("static and report paths cannot escape their configured roots", async (t) => {
  const { port } = await fixture(t);
  const response = await request(port, "/..%2F..%2Fetc%2Fpasswd");
  assert.ok([400, 404].includes(response.status));
  assert.doesNotMatch(response.body, /root:/);
});

test("the local server rejects DNS rebinding hosts and cross-origin API requests", async (t) => {
  const { port } = await fixture(t);
  const rebound = await request(port, "/api/health", {
    headers: { host: `attacker.example:${port}` }
  });
  const crossOrigin = await request(port, "/api/research", {
    method: "POST",
    headers: {
      host: `127.0.0.1:${port}`,
      origin: "https://attacker.example",
      "content-type": "application/json"
    },
    body: JSON.stringify({ subject: { display_name: "Ada Example" } })
  });

  assert.equal(rebound.status, 421);
  assert.equal(crossOrigin.status, 403);
});

test("the local server refuses a symlink that escapes a served root", async (t) => {
  const { port, websiteRoot, root } = await fixture(t);
  const secret = path.join(root, "outside-secret.txt");
  await writeFile(secret, "not public", "utf8");
  await symlink(secret, path.join(websiteRoot, "escaped.txt"));

  const response = await request(port, "/escaped.txt");
  assert.equal(response.status, 403);
  assert.doesNotMatch(response.body, /not public/);
});

test("the local server aborts a research job that exceeds its wall-time budget", async (t) => {
  const { port } = await fixture(t, {
    maxRunMs: 20,
    async runProduct(_brief, { signal }) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
  });
  const brief = createResearchBrief({
    subjectName: "Ada Example",
    profileUrls: ["https://github.com/ada-example"],
    purpose: "self_audit",
    depth: "quick",
    modules: ["identity"]
  });
  const response = await request(port, "/api/research", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(brief)
  });

  assert.equal(response.status, 504);
  assert.match(response.body, /deadline/i);
});
