import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

import { validateResearchBrief } from "../website/lib/research-brief.mjs";
import { detectLocalCapabilities } from "../runner/capabilities.mjs";

const MAX_REQUEST_BYTES = 1_000_000;
const REQUEST_BODY_TIMEOUT_MS = 15_000;
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;
const HERE = path.dirname(fileURLToPath(import.meta.url));

const CONTENT_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webp": "image/webp"
});

function securityHeaders(response) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("content-security-policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  response.setHeader("cache-control", "no-store");
}

function sendJson(response, status, payload) {
  securityHeaders(response);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(payload)}\n`);
}

function safeFile(root, requestedPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestedPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.split("/").includes("..")) return null;
  const candidate = path.resolve(root, `.${decoded}`);
  const resolvedRoot = path.resolve(root);
  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${path.sep}`)) return null;
  return candidate;
}

function parsedLoopbackHost(value) {
  try {
    const url = new URL(`http://${value}`);
    if (url.username || url.password) return null;
    const hostname = url.hostname.toLowerCase();
    if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

function requestBoundaryError(request) {
  const host = parsedLoopbackHost(request.headers.host);
  if (!host) return { status: 421, error: "Local server requests must use a loopback Host" };
  const origin = request.headers.origin;
  if (!origin) return null;
  try {
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.protocol !== "http:" || parsedOrigin.host.toLowerCase() !== host.host.toLowerCase()) {
      return { status: 403, error: "Cross-origin local research requests are not allowed" };
    }
  } catch {
    return { status: 403, error: "Invalid request Origin" };
  }
  return null;
}

async function serveFile(response, root, requestedPath, method) {
  let filePath = safeFile(root, requestedPath);
  if (!filePath) {
    sendJson(response, 400, { error: "Invalid path" });
    return;
  }
  try {
    const details = await stat(filePath);
    if (details.isDirectory()) filePath = path.join(filePath, "index.html");
    const [resolvedRoot, resolvedFile] = await Promise.all([realpath(root), realpath(filePath)]);
    if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
      return sendJson(response, 403, { error: "Path leaves the configured root" });
    }
    filePath = resolvedFile;
    const finalDetails = await stat(filePath);
    if (!finalDetails.isFile()) throw new Error("not a file");
    securityHeaders(response);
    response.statusCode = 200;
    response.setHeader("content-type", CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream");
    response.setHeader("content-length", String(finalDetails.size));
    if (method === "HEAD") response.end();
    else createReadStream(filePath).pipe(response);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

function readJsonBody(request) {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (declaredLength > MAX_REQUEST_BYTES) {
    const error = new Error("Request body is too large");
    error.code = "BODY_TOO_LARGE";
    request.resume();
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => {
      const error = new Error("Request body timed out");
      error.code = "BODY_TIMEOUT";
      request.resume();
      reject(error);
    }, REQUEST_BODY_TIMEOUT_MS);
    timer.unref?.();
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        const error = new Error("Request body is too large");
        error.code = "BODY_TOO_LARGE";
        clearTimeout(timer);
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new SyntaxError("Request body must be valid JSON"));
      }
    });
  });
}

async function defaultRunProduct(brief, options) {
  const { runResearchProduct } = await import("../runner/research-product.mjs");
  return runResearchProduct(brief, options);
}

export function createLocalServer(options = {}) {
  const websiteRoot = path.resolve(options.websiteRoot ?? path.join(HERE, "..", "website"));
  const runRoot = path.resolve(options.runRoot ?? path.join(process.cwd(), "public-profile-runs"));
  const runProduct = options.runProduct ?? defaultRunProduct;
  const detectCapabilities = options.detectCapabilities ?? detectLocalCapabilities;
  const maxRunMs = options.maxRunMs ?? DEFAULT_RUN_TIMEOUT_MS;
  if (!Number.isFinite(maxRunMs) || maxRunMs <= 0) throw new TypeError("maxRunMs must be a positive number");
  const completedRuns = new Map();
  let active = false;
  let capabilities = null;
  const capabilityPromise = Promise.resolve()
    .then(() => detectCapabilities())
    .then((result) => {
      capabilities = result;
      return result;
    })
    .catch(() => {
      capabilities = { checked_at: new Date().toISOString(), tools: {}, platforms: [], summary: { text: "Capability detection did not complete." } };
      return capabilities;
    });

  return http.createServer(async (request, response) => {
    try {
      const boundaryError = requestBoundaryError(request);
      if (boundaryError) return sendJson(response, boundaryError.status, { error: boundaryError.error });
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname === "/api/health") {
        if (request.method !== "GET" && request.method !== "HEAD") return sendJson(response, 405, { error: "Method not allowed" });
        return sendJson(response, 200, { status: "ok", research: true, research_engine: "available", local_only: true, active, capabilities_status: capabilities ? "ready" : "checking", ...(capabilities ? { capabilities } : {}) });
      }

      if (requestUrl.pathname === "/api/capabilities") {
        if (request.method !== "GET" && request.method !== "HEAD") return sendJson(response, 405, { error: "Method not allowed" });
        return sendJson(response, 200, { capabilities: await capabilityPromise });
      }

      if (requestUrl.pathname === "/api/research") {
        if (request.method !== "POST") return sendJson(response, 405, { error: "Use POST for research" });
        if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
          return sendJson(response, 415, { error: "Use application/json" });
        }
        if (active) return sendJson(response, 429, { error: "A local research run is already active" });
        active = true;
        try {
          const brief = await readJsonBody(request);
          const validationErrors = validateResearchBrief(brief);
          if (validationErrors.length) return sendJson(response, 400, { error: validationErrors.join("; ") });
          const provisionalId = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${crypto.randomUUID()}`;
          const outputDirectory = path.join(runRoot, provisionalId);
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(new Error(`Research run exceeded its ${maxRunMs}ms deadline`)), maxRunMs);
          timer.unref?.();
          let run;
          try {
            const aborted = new Promise((_, reject) => {
              controller.signal.addEventListener("abort", () => {
                const error = controller.signal.reason instanceof Error ? controller.signal.reason : new Error("Research run aborted");
                error.code = "RUN_TIMEOUT";
                reject(error);
              }, { once: true });
            });
            run = await Promise.race([runProduct(brief, { outputDirectory, signal: controller.signal }), aborted]);
          } finally {
            clearTimeout(timer);
          }
          const runId = String(run?.run_id ?? provisionalId);
          completedRuns.set(runId, outputDirectory);
          const reportUrl = `/runs/${encodeURIComponent(runId)}/report/index.html`;
          return sendJson(response, 200, { run: { ...run, report_url: reportUrl }, report_url: reportUrl });
        } catch (error) {
          const status = error?.code === "BODY_TOO_LARGE" ? 413 : error?.code === "BODY_TIMEOUT" ? 408 : error?.code === "RUN_TIMEOUT" ? 504 : 400;
          return sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
        } finally {
          active = false;
        }
      }

      const runMatch = requestUrl.pathname.match(/^\/runs\/([^/]+)(\/.*)$/);
      if (runMatch) {
        if (request.method !== "GET" && request.method !== "HEAD") return sendJson(response, 405, { error: "Method not allowed" });
        const runId = decodeURIComponent(runMatch[1]);
        const root = completedRuns.get(runId);
        if (!root) return sendJson(response, 404, { error: "Unknown or expired local run" });
        return serveFile(response, root, runMatch[2], request.method);
      }

      if (request.method !== "GET" && request.method !== "HEAD") return sendJson(response, 405, { error: "Method not allowed" });
      return serveFile(response, websiteRoot, requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname, request.method);
    } catch (error) {
      return sendJson(response, 500, { error: error instanceof Error ? error.message : "Unexpected local server error" });
    }
  });
}

function parsePort(argv) {
  const index = argv.indexOf("--port");
  if (index === -1) return 4173;
  const port = Number(argv[index + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("--port must be an integer from 1 to 65535");
  return port;
}

async function main() {
  const port = parsePort(process.argv.slice(2));
  const server = createLocalServer();
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`Public Profile Research is available at http://127.0.0.1:${port}\n`);
    process.stdout.write("The server is bound to this computer only. Press Ctrl+C to stop it.\n");
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
