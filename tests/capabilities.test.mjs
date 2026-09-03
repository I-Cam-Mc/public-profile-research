import assert from "node:assert/strict";
import test from "node:test";

import { detectLocalCapabilities } from "../runner/capabilities.mjs";

const SECRET = "ghp_do_not_return_this_value";

test("local capability check returns safe tool and Agent Reach platform states", async () => {
  const calls = [];
  const execFileImpl = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "gh") {
      return { stdout: "gh version 2.76.2 (2026-08-20)\n", stderr: "" };
    }
    if (command === "yt-dlp") {
      return { stdout: "2026.08.11\n", stderr: "" };
    }
    return {
      stdout: JSON.stringify({
        youtube: {
          status: "ok",
          active_backend: "yt-dlp",
          message: `Configured with ${SECRET}`
        },
        instagram: {
          status: "off",
          active_backend: null,
          message: `Missing cookie ${SECRET}`
        },
        linkedin: {
          status: "warn",
          active_backend: null,
          message: `Environment: ${SECRET}`
        },
        web: {
          status: "ok",
          active_backend: "Jina Reader",
          message: "Ready"
        },
        unexpected_secret_key: {
          status: "ok",
          active_backend: SECRET,
          message: SECRET
        }
      }),
      stderr: ""
    };
  };

  const result = await detectLocalCapabilities({
    execFileImpl,
    now: () => new Date("2026-09-03T08:00:00.000Z")
  });

  assert.equal(result.checked_at, "2026-09-03T08:00:00.000Z");
  assert.deepEqual(result.tools.github_cli, {
    id: "github_cli",
    label: "GitHub CLI",
    state: "ready",
    state_label: "Ready",
    version: "2.76.2",
    detail: "Installed (version 2.76.2)."
  });
  assert.deepEqual(result.tools.yt_dlp, {
    id: "yt_dlp",
    label: "yt-dlp",
    state: "ready",
    state_label: "Ready",
    version: "2026.08.11",
    detail: "Installed (version 2026.08.11)."
  });
  assert.deepEqual(result.tools.agent_reach, {
    id: "agent_reach",
    label: "Agent Reach",
    state: "ready",
    state_label: "Ready",
    detail: "Installed and its capability report was read successfully."
  });
  assert.deepEqual(result.platforms, [
    {
      id: "youtube",
      label: "YouTube",
      state: "ready",
      state_label: "Ready",
      backend: "yt-dlp",
      detail: "A local read route is available.",
      runner_collectable: true,
      runner_support: "implemented",
      runner_detail: "This runner has a collection adapter for the route."
    },
    {
      id: "instagram",
      label: "Instagram",
      state: "unavailable",
      state_label: "Unavailable",
      detail: "No local read route is currently available.",
      runner_collectable: true,
      runner_support: "implemented",
      runner_detail: "This runner has a collection adapter for the route."
    },
    {
      id: "linkedin",
      label: "LinkedIn",
      state: "check_needed",
      state_label: "Check needed",
      detail: "A route may be configured, but it has not been live-verified.",
      runner_collectable: true,
      runner_support: "implemented",
      runner_detail: "This runner has a collection adapter for the route."
    },
    {
      id: "web",
      label: "Public web pages",
      state: "ready",
      state_label: "Ready",
      backend: "Jina Reader",
      detail: "A local read route is available.",
      runner_collectable: true,
      runner_support: "implemented",
      runner_detail: "This runner has a collection adapter for the route."
    }
  ]);
  assert.deepEqual(result.summary, {
    tools_ready: 3,
    tools_total: 3,
    platforms_ready: 2,
    platforms_check_needed: 1,
    platforms_unavailable: 1,
    platforms_unknown: 0,
    platforms_collectable_ready: 2,
    platforms_detected_only_ready: 0,
    text: "3 of 3 research tools are ready. Agent Reach reports 2 ready platform routes, 1 needing a check and 1 unavailable."
  });

  assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [
    { command: "gh", args: ["--version"] },
    { command: "yt-dlp", args: ["--version"] },
    { command: "agent-reach", args: ["doctor", "--json"] }
  ]);
  assert.ok(calls.every(({ options }) => options.shell === false));
  assert.ok(calls.every(({ options }) => options.timeout > 0 && options.timeout <= 20_000));
  assert.ok(calls.every(({ options }) => options.maxBuffer > 0 && options.maxBuffer <= 512 * 1024));
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("missing optional commands are reported as normal unavailable states", async () => {
  const execFileImpl = async (command) => {
    const error = new Error(`spawn ${command} ENOENT`);
    error.code = "ENOENT";
    error.path = command;
    throw error;
  };

  const result = await detectLocalCapabilities({ execFileImpl });

  assert.deepEqual(
    Object.values(result.tools).map(({ state }) => state),
    ["unavailable", "unavailable", "unavailable"]
  );
  assert.equal(result.platforms.length, 0);
  assert.equal(
    result.summary.text,
    "No optional research tools were detected. Install only the routes needed for this research job."
  );
});

test("failed or malformed checks return bounded generic messages without command output", async () => {
  const execFileImpl = async (command) => {
    if (command === "agent-reach") {
      return { stdout: `{not-json:${SECRET}}`, stderr: SECRET };
    }
    const error = new Error(`failed with ${SECRET}`);
    error.stderr = `token=${SECRET}`;
    if (command === "yt-dlp") {
      error.killed = true;
      error.signal = "SIGTERM";
    }
    throw error;
  };

  const result = await detectLocalCapabilities({ execFileImpl });

  assert.equal(result.tools.github_cli.state, "check_failed");
  assert.equal(result.tools.github_cli.detail, "The local check did not complete successfully.");
  assert.equal(result.tools.yt_dlp.state, "check_failed");
  assert.equal(result.tools.yt_dlp.detail, "The local check timed out.");
  assert.equal(result.tools.agent_reach.state, "check_failed");
  assert.equal(result.tools.agent_reach.detail, "Agent Reach returned an unreadable capability report.");
  assert.equal(result.platforms.length, 0);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("unknown Agent Reach status and backend values are normalised rather than echoed", async () => {
  const execFileImpl = async (command) => {
    if (command !== "agent-reach") return { stdout: "1.0.0\n", stderr: "" };
    return {
      stdout: JSON.stringify({
        twitter: { status: `secret-${SECRET}`, active_backend: SECRET },
        exa_search: { status: "ok", active_backend: SECRET }
      }),
      stderr: ""
    };
  };

  const result = await detectLocalCapabilities({ execFileImpl });

  assert.deepEqual(result.platforms, [
    {
      id: "twitter",
      label: "X (Twitter)",
      state: "unknown",
      state_label: "Unknown",
      detail: "Agent Reach returned an unrecognised route state.",
      runner_collectable: true,
      runner_support: "implemented",
      runner_detail: "This runner has a collection adapter for the route."
    },
    {
      id: "exa_search",
      label: "Web discovery (Exa)",
      state: "ready",
      state_label: "Ready",
      detail: "A local read route is available.",
      runner_collectable: true,
      runner_support: "implemented",
      runner_detail: "This runner has a collection adapter for the route."
    }
  ]);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("Agent Reach discovery distinguishes detected routes from routes implemented by this runner", async () => {
  const execFileImpl = async (command) => {
    if (command !== "agent-reach") return { stdout: "1.0.0\n", stderr: "" };
    return {
      stdout: JSON.stringify({
        instagram: { status: "ok", active_backend: "OpenCLI" },
        reddit: { status: "ok", active_backend: "OpenCLI" },
        exa_search: { status: "ok", active_backend: "Exa via mcporter" }
      }),
      stderr: ""
    };
  };

  const result = await detectLocalCapabilities({ execFileImpl });
  const byId = Object.fromEntries(result.platforms.map((platform) => [platform.id, platform]));

  assert.equal(byId.instagram.runner_collectable, true);
  assert.equal(byId.instagram.runner_support, "implemented");
  assert.equal(byId.exa_search.runner_collectable, true);
  assert.equal(byId.reddit.runner_collectable, false);
  assert.equal(byId.reddit.runner_support, "detected_only");
  assert.match(byId.reddit.runner_detail, /not implemented/i);
  assert.equal(result.summary.platforms_collectable_ready, 2);
  assert.equal(result.summary.platforms_detected_only_ready, 1);
});
