import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const websiteRoot = new URL("../website/", import.meta.url);

async function readWebsiteFile(name) {
  return readFile(new URL(name, websiteRoot), "utf8");
}

test("the public website exposes an accessible research intake and honest run modes", async () => {
  const html = await readWebsiteFile("index.html");

  assert.match(html, /<form[^>]+id="research-form"/i);
  assert.match(html, /Guided interview/i);
  assert.match(html, /All fields/i);
  assert.match(html, /Public sources only/i);
  assert.match(html, /Static export mode/i);
  assert.match(html, /aria-live="polite"/i);
  assert.match(html, /id="research-results"/i);
  assert.match(html, /href="https:\/\/github\.com\/octocat"/i);
});

test("the client can probe the API, start a real run and export a portable pack", async () => {
  const [html, client] = await Promise.all([
    readWebsiteFile("index.html"),
    readWebsiteFile("app.js")
  ]);

  assert.match(html, /id="research-mode"/);
  assert.match(client, /from "\.\/lib\/research-brief\.mjs"/);
  assert.match(client, /fetch\("\/api\/health"/);
  assert.match(client, /fetch\("\/api\/capabilities"/);
  assert.match(client, /fetch\("\/api\/research"/);
  assert.match(client, /method:\s*"POST"/);
  assert.match(client, /run\.report_url/);
  assert.match(client, /Open generated report/);
  assert.match(client, /buildPortablePrompt/);
  assert.match(client, /downloadJson/);
  assert.match(client, /downloadText/);
});

test("the local interface requires an explicit user action to confirm profile identity", async () => {
  const [html, client] = await Promise.all([
    readWebsiteFile("index.html"),
    readWebsiteFile("app.js")
  ]);

  assert.match(html, /id="identity-confirmed"[^>]+type="checkbox"|type="checkbox"[^>]+id="identity-confirmed"/i);
  assert.match(html, /checked that every profile URL.*same person/i);
  assert.match(client, /identityConfirmed:\s*document\.querySelector\("#identity-confirmed"\)/);
  assert.match(client, /identityStatus:\s*ui\.identityConfirmed\.checked\s*\?\s*"confirmed"\s*:\s*"unconfirmed"/);
});

test("the website is responsive, respects reduced motion and has no runtime dependencies", async () => {
  const [html, css, client] = await Promise.all([
    readWebsiteFile("index.html"),
    readWebsiteFile("styles.css"),
    readWebsiteFile("app.js")
  ]);

  assert.match(css, /@media\s*\(max-width:\s*760px\)/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /:focus-visible/);
  assert.doesNotMatch(html, /<script[^>]+src="https?:\/\//i);
  assert.doesNotMatch(html, /<link[^>]+href="https?:\/\//i);
  assert.doesNotMatch(`${html}\n${css}\n${client}`, /—/);
});

test("the website explains that managed tiers buy execution rather than a hidden method", async () => {
  const html = await readWebsiteFile("index.html");

  assert.match(html, /\$20/);
  assert.match(html, /\$80/);
  assert.match(html, /\$200/);
  assert.match(html, /same open method/i);
  assert.match(html, /checkout is not live/i);
});

test("the local interface distinguishes free built-in routes from changeable external terms", async () => {
  const client = await readWebsiteFile("app.js");

  assert.doesNotMatch(client, /No checkout or paid service is involved/i);
  assert.match(client, /no project checkout or paid API key/i);
  assert.match(client, /external services can impose quotas or change terms/i);
});

test("the ordinary browser intake cannot select coverage modes the local runner cannot close", async () => {
  const [html, client] = await Promise.all([
    readWebsiteFile("index.html"),
    readWebsiteFile("app.js")
  ]);

  assert.match(html, /<option[^>]+value="bounded_census"[^>]+disabled/i);
  assert.match(html, /<option[^>]+value="maximum_public_coverage"[^>]+disabled/i);
  assert.match(html, /does not generate.*denominator enumeration receipts/i);
  assert.doesNotMatch(client, /data:\s*\{\s*guideMode:\s*"bounded_census"/);
  assert.doesNotMatch(client, /data:\s*\{\s*guideMode:\s*"maximum_public_coverage"/);
  assert.match(client, /Census and maximum coverage remain advanced contract modes/i);
});

test("the browser does not present collection success as completed requested analysis", async () => {
  const client = await readWebsiteFile("app.js");

  assert.match(client, /moduleRequirementsSatisfied/);
  assert.match(client, /status === "completed" && goalSatisfied && identityConfirmed && moduleRequirementsSatisfied/);
  assert.match(client, /Requested analysis remains open/i);
});
