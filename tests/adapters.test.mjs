import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultAdapters } from "../runner/adapters.mjs";

test("the GitHub adapter performs a real public-profile and repository collection", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    const body = String(url).includes("/repos?")
      ? [{ name: "research-tool", html_url: "https://github.com/ada-example/research-tool" }]
      : { login: "ada-example", name: "Ada Example", public_repos: 1 };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const adapters = createDefaultAdapters({ fetchImpl });
  const result = await adapters.github_public_api.collect({
    platform: "github",
    canonical_url: "https://github.com/ada-example"
  });

  assert.equal(result.status, "collected");
  assert.equal(result.data.profile.login, "ada-example");
  assert.equal(result.data.repositories[0].name, "research-tool");
  assert.deepEqual(requests, [
    "https://api.github.com/users/ada-example",
    "https://api.github.com/users/ada-example/repos?per_page=100&sort=updated"
  ]);
});

test("the Jina adapter preserves a bounded public-page capture", async () => {
  const adapters = createDefaultAdapters({
    fetchImpl: async () => new Response("# Ada Example\n\nPublic profile text", { status: 200 })
  });
  const result = await adapters.jina_reader.collect({
    platform: "web",
    canonical_url: "https://example.com/ada"
  });

  assert.equal(result.status, "collected");
  assert.equal(result.coverage, "reader_visible_page");
  assert.match(result.data.text, /Public profile text/);
});

test("the Jina adapter classifies a login wall instead of reporting collection", async () => {
  const adapters = createDefaultAdapters({
    fetchImpl: async () => new Response("Please sign in to continue. Cookies are required.", { status: 200 })
  });
  const result = await adapters.jina_reader.collect({
    platform: "web",
    canonical_url: "https://example.com/ada"
  });

  assert.equal(result.status, "unavailable");
  assert.equal(result.barrier, "authentication_required");
  assert.equal(result.coverage_complete, false);
});

test("the YouTube adapter invokes yt-dlp without a shell and returns real metadata", async () => {
  const calls = [];
  const adapters = createDefaultAdapters({
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: JSON.stringify({ id: "video-1", title: "An example" }), stderr: "" };
    }
  });
  const result = await adapters.yt_dlp.collect({
    platform: "youtube",
    canonical_url: "https://www.youtube.com/watch?v=video-1"
  }, { brief: { depth: "quick" } });

  assert.equal(result.status, "collected");
  assert.equal(result.data.id, "video-1");
  assert.equal(calls[0].command, "yt-dlp");
  assert.ok(calls[0].args.includes("--dump-single-json"));
  assert.equal(calls[0].options.shell, false);
});

test("the Instagram adapter uses Agent Reach preflight and its OpenCLI route", async () => {
  const commands = [];
  const adapters = createDefaultAdapters({
    execFileImpl: async (command, args) => {
      commands.push([command, ...args]);
      if (command === "agent-reach") {
        return { stdout: JSON.stringify({ instagram: { status: "ok", active_backend: "OpenCLI" } }), stderr: "" };
      }
      return { stdout: "profile: ada-example\nposts: 12\n", stderr: "" };
    }
  });
  const result = await adapters.agent_reach_instagram.collect({
    platform: "instagram",
    canonical_url: "https://www.instagram.com/ada-example/"
  }, { brief: { depth: "quick" } });

  assert.equal(result.status, "collected");
  assert.deepEqual(commands[0], ["agent-reach", "doctor", "--json"]);
  assert.deepEqual(commands[1].slice(0, 4), ["opencli", "instagram", "profile", "ada-example"]);
  assert.deepEqual(commands[1].slice(-2), ["-f", "json"]);
  assert.deepEqual(commands[2].slice(-2), ["-f", "json"]);
  assert.match(result.data.profile, /ada-example/);
});

test("platform handles that could become command options are rejected before execution", async () => {
  let executions = 0;
  const adapters = createDefaultAdapters({
    execFileImpl: async () => {
      executions += 1;
      return { stdout: "", stderr: "" };
    }
  });

  await assert.rejects(() => adapters.agent_reach_instagram.collect({
    platform: "instagram",
    canonical_url: "https://www.instagram.com/--help/"
  }), /valid public handle/i);
  assert.equal(executions, 0);
});
