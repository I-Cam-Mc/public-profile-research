import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import * as capture from "../scripts/capture-report-screenshots.mjs";

test("browser resolution selects the chromium-headless-shell revision pinned by playwright-core", () => {
  const cacheRoot = mkdtempSync(path.join(tmpdir(), "pinned-browser-cache-"));
  const pinnedExecutable = path.join(
    cacheRoot,
    "chromium_headless_shell-1228",
    "chrome-headless-shell-linux64",
    "chrome-headless-shell"
  );
  const newerExecutable = path.join(
    cacheRoot,
    "chromium_headless_shell-9999",
    "chrome-headless-shell-linux64",
    "chrome-headless-shell"
  );
  fs.mkdirSync(path.dirname(pinnedExecutable), { recursive: true });
  fs.mkdirSync(path.dirname(newerExecutable), { recursive: true });
  fs.writeFileSync(pinnedExecutable, "pinned browser");
  fs.writeFileSync(newerExecutable, "newer but incompatible browser");

  const resolved = capture.resolveBrowser({
    cacheRoots: [cacheRoot],
    platform: "linux",
    architecture: "x64",
    configuredExecutable: null,
    browsersManifest: {
      browsers: [
        { name: "chromium-headless-shell", revision: "1228", installByDefault: true },
        { name: "chromium-tip-of-tree-headless-shell", revision: "9999", installByDefault: false }
      ]
    }
  });

  assert.equal(resolved, pinnedExecutable);
});

test("document readiness waits for repeated stable height and block observations within a bound", async () => {
  assert.equal(typeof capture.waitForDocumentReadiness, "function");
  const observations = [
    { scroll_height: 1_000, block_count: 4 },
    { scroll_height: 1_400, block_count: 7 },
    { scroll_height: 1_900, block_count: 9 },
    { scroll_height: 1_900, block_count: 9 },
    { scroll_height: 1_900, block_count: 9 }
  ];
  let calls = 0;

  const result = await capture.waitForDocumentReadiness(
    async () => observations[calls++],
    { maxAttempts: 5, requiredStableSamples: 3, delayMs: 0 }
  );

  assert.equal(calls, 5);
  assert.deepEqual(result, {
    attempts: 5,
    stable_samples: 3,
    observation: { scroll_height: 1_900, block_count: 9 }
  });
});

test("document readiness fails at its attempt bound when the document never converges", async () => {
  assert.equal(typeof capture.waitForDocumentReadiness, "function");
  let calls = 0;

  await assert.rejects(
    capture.waitForDocumentReadiness(
      async () => ({ scroll_height: 1_000 + calls++ * 100, block_count: 4 + calls }),
      { maxAttempts: 4, requiredStableSamples: 3, delayMs: 0 }
    ),
    /did not converge after 4 observations/i
  );
  assert.equal(calls, 4);
});

test("capture network policy explicitly blocks WebSocket connections", () => {
  assert.equal(typeof capture.createCaptureNetworkPolicy, "function");
  const reportUrl = "file:///private/tmp/report/report.html";
  const policy = capture.createCaptureNetworkPolicy(reportUrl);

  assert.equal(policy.allowsHttpRequest(reportUrl), true);
  assert.equal(policy.allowsHttpRequest("https://example.test/tracker.js"), false);
  assert.equal(policy.allowsWebSocket("ws://127.0.0.1:3000/live"), false);
  assert.equal(policy.allowsWebSocket("wss://example.test/live"), false);
  assert.deepEqual(policy.descriptor, {
    http: "exact_report_file_and_embedded_data_only",
    websocket: "blocked",
    service_worker: "blocked"
  });
});

test("full-page capture preparation returns the document to the origin after table probes", async () => {
  const originalWindow = globalThis.window;
  const originalAnimationFrame = globalThis.requestAnimationFrame;
  const scrollCalls = [];
  globalThis.window = {
    scrollY: 7_200,
    scrollTo(x, y) {
      scrollCalls.push([x, y]);
      this.scrollY = y;
    }
  };
  globalThis.requestAnimationFrame = (callback) => callback();

  try {
    const scrollY = await capture.resetDocumentScrollForFullPage({
      evaluate: async (callback) => callback()
    });
    assert.equal(scrollY, 0);
    assert.deepEqual(scrollCalls, [[0, 0]]);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalAnimationFrame;
  }
});
