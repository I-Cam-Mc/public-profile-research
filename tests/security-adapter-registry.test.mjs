import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createSafeDefaultAdapters } from "../runner/safe-adapters.mjs";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("safe adapter registry rejects private targets before a reader fetch", async () => {
  let fetchCount = 0;
  const adapters = createSafeDefaultAdapters({
    lookup: publicLookup,
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response("should not be reached");
    }
  });

  await assert.rejects(
    () => adapters.jina_reader.collect({ platform: "web", canonical_url: "https://127.0.0.1/admin" }),
    /public IP address/i
  );
  assert.equal(fetchCount, 0);
});

test("safe command adapters pass targets as argument arrays with shell disabled", async () => {
  const calls = [];
  const adapters = createSafeDefaultAdapters({
    lookup: publicLookup,
    fetchImpl: async () => new Response("unused"),
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: JSON.stringify({ id: "video-1", title: "Example" }), stderr: "" };
    }
  });

  const targetUrl = "https://www.youtube.com/watch?v=abc;touch%20/tmp/nope";
  const result = await adapters.yt_dlp.collect(
    { platform: "youtube", canonical_url: targetUrl },
    { brief: { depth: "quick" } }
  );

  assert.equal(result.status, "collected");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "yt-dlp");
  assert.ok(Array.isArray(calls[0].args));
  assert.equal(calls[0].args.at(-1), targetUrl);
  assert.ok(calls.every((call) => call.options.shell === false && call.args.at(-1) === targetUrl));
});

test("safe platform adapters reject option-like handles before invoking a command", async () => {
  let executions = 0;
  const adapters = createSafeDefaultAdapters({
    lookup: publicLookup,
    fetchImpl: async () => new Response("unused"),
    execFileImpl: async () => {
      executions += 1;
      return { stdout: "", stderr: "" };
    }
  });

  const result = await adapters.agent_reach_facebook.collect({
    platform: "facebook",
    canonical_url: "https://www.facebook.com/--help/"
  }, { brief: { depth: "quick" } });

  assert.equal(result.status, "failed");
  assert.match(result.message, /valid public handle/i);
  assert.equal(executions, 0);
});

test("Agent Reach X adapter reports a disabled backend honestly", async () => {
  const calls = [];
  const adapters = createSafeDefaultAdapters({
    lookup: publicLookup,
    fetchImpl: async () => new Response("unused"),
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return {
        stdout: JSON.stringify({ twitter: { status: "off", active_backend: null, message: "Twitter CLI is not installed" } }),
        stderr: ""
      };
    }
  });

  const result = await adapters.agent_reach_x.collect({
    platform: "x",
    canonical_url: "https://x.com/alice"
  }, { brief: { depth: "quick" } });

  assert.deepEqual(result, {
    status: "unavailable",
    barrier: "backend_unavailable",
    message: "Twitter CLI is not installed",
    data: { health: { status: "off", active_backend: null, message: "Twitter CLI is not installed" } }
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["doctor", "--json"]);
  assert.equal(calls[0].options.shell, false);
});

test("Agent Reach X adapter task-probes OpenCLI when doctor is inconclusive", async () => {
  const calls = [];
  const adapters = createSafeDefaultAdapters({
    lookup: publicLookup,
    fetchImpl: async () => new Response("unused"),
    environment: { PATH: "/usr/bin" },
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === "agent-reach") {
        return {
          stdout: JSON.stringify({
            twitter: {
              status: "warn",
              active_backend: null,
              message: "OpenCLI was not live-tested to avoid reading browser state"
            }
          }),
          stderr: ""
        };
      }
      if (command === "opencli") {
        return { stdout: JSON.stringify([{ id: "123", text: "Public post" }]), stderr: "" };
      }
      throw new Error(`Unexpected command: ${command}`);
    }
  });

  const result = await adapters.agent_reach_x.collect({
    platform: "x",
    canonical_url: "https://x.com/alice"
  }, { brief: { depth: "quick" } });

  assert.equal(result.status, "collected");
  assert.equal(result.data.backend, "OpenCLI (task probe)");
  assert.deepEqual(calls.map(({ command }) => command), ["agent-reach", "opencli"]);
  assert.deepEqual(calls[1].args, ["twitter", "user-posts", "@alice", "-f", "json"]);
  assert.equal(calls[1].options.shell, false);
  assert.equal(JSON.stringify(calls[1].args).includes("token"), false);
});

test("Agent Reach X adapter declares authentication unavailable only after its OpenCLI task probe", async () => {
  const calls = [];
  const adapters = createSafeDefaultAdapters({
    lookup: publicLookup,
    fetchImpl: async () => new Response("unused"),
    environment: { PATH: "/usr/bin" },
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === "agent-reach") {
        return {
          stdout: JSON.stringify({ twitter: { status: "warn", active_backend: null, message: "Not live-tested" } }),
          stderr: ""
        };
      }
      const error = new Error("OpenCLI login required");
      error.stderr = "login required";
      throw error;
    }
  });

  const result = await adapters.agent_reach_x.collect({
    platform: "x",
    canonical_url: "https://x.com/alice"
  }, { brief: { depth: "quick" } });

  assert.equal(result.status, "unavailable");
  assert.equal(result.barrier, "authentication_required");
  assert.deepEqual(calls.map(({ command }) => command), ["agent-reach", "opencli"]);
  assert.deepEqual(calls[1].args, ["twitter", "user-posts", "@alice", "-f", "json"]);
  assert.equal(calls[1].options.shell, false);
});

test("Agent Reach X adapter keeps authentication values out of command arguments", async () => {
  const calls = [];
  const environment = { TWITTER_AUTH_TOKEN: "token-value", TWITTER_CT0: "csrf-value", PATH: "/usr/bin" };
  const adapters = createSafeDefaultAdapters({
    lookup: publicLookup,
    fetchImpl: async () => new Response("unused"),
    environment,
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === "agent-reach") {
        return { stdout: JSON.stringify({ twitter: { status: "ok", active_backend: "twitter-cli" } }), stderr: "" };
      }
      return { stdout: `${command} public result`, stderr: "" };
    }
  });

  const result = await adapters.agent_reach_x.collect({
    platform: "x",
    canonical_url: "https://x.com/alice"
  }, { brief: { depth: "quick" } });

  assert.equal(result.status, "collected");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].args, ["user", "@alice"]);
  assert.deepEqual(calls[2].args, ["user-posts", "@alice", "-n", "20"]);
  assert.equal(JSON.stringify(calls.map((call) => call.args)).includes("token-value"), false);
  assert.equal(JSON.stringify(calls.map((call) => call.args)).includes("csrf-value"), false);
  assert.equal(calls[1].options.env, environment);
  assert.equal(calls[1].options.shell, false);
});

test("Agent Reach Facebook adapter uses the signed-in read-only profile route", async () => {
  const calls = [];
  const adapters = createSafeDefaultAdapters({
    lookup: publicLookup,
    fetchImpl: async () => new Response("unused"),
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === "agent-reach") {
        return { stdout: JSON.stringify({ facebook: { status: "ok", active_backend: "OpenCLI" } }), stderr: "" };
      }
      return { stdout: "public Facebook profile", stderr: "" };
    }
  });

  const result = await adapters.agent_reach_facebook.collect({
    platform: "facebook",
    canonical_url: "https://www.facebook.com/alice.public"
  }, { brief: { depth: "quick" } });

  assert.equal(result.status, "collected");
  assert.equal(result.coverage, "authenticated_public_profile");
  assert.deepEqual(calls[1].args, ["facebook", "profile", "alice.public", "-f", "json"]);
  assert.equal(calls[1].options.shell, false);
});

test("Agent Reach LinkedIn adapter manually validates the configured profile reader", async () => {
  const calls = [];
  const adapters = createSafeDefaultAdapters({
    lookup: publicLookup,
    fetchImpl: async () => new Response("unused"),
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === "agent-reach") {
        return { stdout: JSON.stringify({ linkedin: { status: "warn", active_backend: null, message: "Not live-tested" } }), stderr: "" };
      }
      return { stdout: JSON.stringify({ name: "Alice", experience: [] }), stderr: "" };
    }
  });

  const result = await adapters.agent_reach_linkedin.collect({
    platform: "linkedin",
    canonical_url: "https://www.linkedin.com/in/alice-example/"
  }, { brief: { depth: "quick" } });

  assert.equal(result.status, "collected");
  assert.equal(result.coverage, "authenticated_public_profile_experience_and_education");
  assert.deepEqual(calls[1].args, [
    "call",
    "linkedin.get_person_profile",
    "linkedin_username=alice-example",
    "sections=experience,education"
  ]);
  assert.equal(calls[1].options.shell, false);
});

test("Agent Reach Exa adapter performs a live bounded discovery query", async () => {
  const calls = [];
  const adapters = createSafeDefaultAdapters({
    lookup: publicLookup,
    fetchImpl: async () => new Response("unused"),
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === "agent-reach") {
        return { stdout: JSON.stringify({ exa_search: { status: "warn", active_backend: null, message: "Configured but not live-tested" } }), stderr: "" };
      }
      return { stdout: JSON.stringify({ results: [{ title: "Alice Example", url: "https://example.com/alice" }] }), stderr: "" };
    }
  });

  const result = await adapters.agent_reach_exa.collect({
    platform: "web_search",
    canonical_url: "https://github.com/alice-example",
    query: "\"Alice Example\" alice-example",
    max_results: 6
  }, { brief: { depth: "quick" } });

  assert.equal(result.status, "collected");
  assert.equal(result.coverage, "exa_semantic_search_up_to_6_results");
  assert.ok(result.source_urls.includes("https://example.com/alice"));
  assert.deepEqual(calls[1].args, [
    "call",
    "exa.web_search_exa",
    "query=\"Alice Example\" alice-example",
    "numResults=6"
  ]);
  assert.equal(calls[1].options.shell, false);
});

test("safe adapter registry classifies a signed-in platform access failure", async () => {
  const adapters = createSafeDefaultAdapters({
    lookup: publicLookup,
    fetchImpl: async () => new Response("unused"),
    execFileImpl: async (command) => {
      if (command === "agent-reach") {
        return { stdout: JSON.stringify({ instagram: { status: "ok", active_backend: "OpenCLI" } }), stderr: "" };
      }
      const error = new Error("OpenCLI failed");
      error.stderr = "login required: refresh the Instagram session";
      throw error;
    }
  });

  const result = await adapters.agent_reach_instagram.collect({
    platform: "instagram",
    canonical_url: "https://www.instagram.com/alice/"
  }, { brief: { depth: "quick" } });

  assert.equal(result.status, "unavailable");
  assert.equal(result.barrier, "authentication_required");
  assert.match(result.message, /login required/i);
});

test("adapter diagnostics redact credential-shaped values before persistence", async () => {
  const adapters = createSafeDefaultAdapters({
    lookup: publicLookup,
    fetchImpl: async () => new Response("unused"),
    execFileImpl: async (command) => {
      if (command === "agent-reach") return { stdout: JSON.stringify({ facebook: { status: "ok", active_backend: "OpenCLI" } }), stderr: "" };
      const error = new Error("login failed");
      error.stderr = "TWITTER_AUTH_TOKEN=secret-token-123 Authorization: Bearer super-secret";
      throw error;
    }
  });

  const result = await adapters.agent_reach_facebook.collect({
    platform: "facebook",
    canonical_url: "https://www.facebook.com/alice.example/"
  });

  assert.doesNotMatch(result.message, /secret-token-123|super-secret/);
  assert.match(result.message, /REDACTED/);
});

test("bounded web reader refuses non-text response bodies", async () => {
  const adapters = createSafeDefaultAdapters({
    lookup: publicLookup,
    fetchImpl: async () => new Response(new Uint8Array([0, 1, 2, 3]), {
      status: 200,
      headers: { "content-type": "application/octet-stream" }
    })
  });

  const result = await adapters.jina_reader.collect({
    platform: "web",
    canonical_url: "https://example.com/alice"
  });

  assert.equal(result.status, "unavailable");
  assert.equal(result.barrier, "unsupported_content_type");
  assert.match(result.message, /application\/octet-stream/);
});

test("bounded web reader preserves but does not promote a login wall", async () => {
  const adapters = createSafeDefaultAdapters({
    lookup: publicLookup,
    fetchImpl: async () => new Response("Please sign in to continue. Cookies are required.", {
      status: 200,
      headers: { "content-type": "text/plain" }
    })
  });

  const result = await adapters.jina_reader.collect({
    platform: "web",
    canonical_url: "https://example.com/alice"
  });

  assert.equal(result.status, "unavailable");
  assert.equal(result.barrier, "authentication_required");
  assert.equal(result.coverage_complete, false);
  assert.match(result.data.text, /sign in/i);
});

test("GitHub collection uses the authenticated CLI when it is available", async () => {
  const calls = [];
  const adapters = createSafeDefaultAdapters({
    lookup: publicLookup,
    fetchImpl: async () => { throw new Error("public API fallback should not be needed"); },
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      const body = args[1].includes("/repos?")
        ? [{ name: "public-project" }]
        : { login: "alice", public_repos: 1 };
      return { stdout: JSON.stringify(body), stderr: "" };
    }
  });

  const result = await adapters.github_public_api.collect({
    platform: "github",
    canonical_url: "https://github.com/alice"
  });

  assert.equal(result.status, "collected");
  assert.equal(result.coverage_complete, true);
  assert.equal(result.data.backend, "authenticated_gh_cli");
  assert.deepEqual(calls.map((call) => call.args), [
    ["api", "users/alice"],
    ["api", "users/alice/repos?per_page=100&sort=updated"]
  ]);
  assert.ok(calls.every((call) => call.command === "gh" && call.options.shell === false));
});

test("YouTube collection preserves available captions as research evidence", async () => {
  const calls = [];
  const adapters = createSafeDefaultAdapters({
    lookup: publicLookup,
    fetchImpl: async () => new Response("unused"),
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      if (args.includes("--write-auto-subs")) {
        const directory = args[args.indexOf("--paths") + 1];
        await writeFile(path.join(directory, "video-1.en.vtt"), "WEBVTT\n\n00:00.000 --> 00:02.000\nHello from Alice\n", "utf8");
        return { stdout: "", stderr: "" };
      }
      return { stdout: JSON.stringify({ id: "video-1", title: "Alice explains her work" }), stderr: "" };
    }
  });

  const result = await adapters.yt_dlp.collect({
    platform: "youtube",
    canonical_url: "https://www.youtube.com/watch?v=video-1"
  }, { brief: { depth: "quick" } });

  assert.equal(result.status, "collected");
  assert.equal(result.data.transcript_collection.status, "collected");
  assert.equal(result.data.transcript_collection.files.length, 1);
  assert.match(result.data.transcript_collection.files[0].text, /Hello from Alice/);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].args.includes("--write-auto-subs"));
  assert.ok(calls.every((call) => call.options.shell === false));
});
