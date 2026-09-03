import { lookup as systemLookup } from "node:dns/promises";
import { isIP } from "node:net";

const CREDENTIAL_QUERY_PARAMETER_NAMES = new Set([
  "accesstoken", "apikey", "apitoken", "auth", "authtoken", "authorization",
  "bearer", "clientsecret", "credential", "credentials", "idtoken", "jwt", "key",
  "oauthcode", "password", "passwd", "refreshtoken", "secret", "session", "sessionid",
  "sessionkey", "sessiontoken", "sig", "signature", "token", "xamzcredential",
  "xamzsecuritytoken", "xamzsignature", "xgoogcredential", "xgoogsignature"
]);

function isCredentialQueryParameter(name) {
  return CREDENTIAL_QUERY_PARAMETER_NAMES.has(String(name).toLowerCase().replace(/[^a-z0-9]+/g, ""));
}

function ipv4IsPublic(address) {
  const parts = address.split(".").map(Number);
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && parts[2] === 100) return false;
  if (a === 203 && b === 0 && parts[2] === 113) return false;
  return a >= 1 && a <= 223;
}

function expandIpv6(address) {
  const [left = "", right = ""] = address.toLowerCase().split("::");
  const leftParts = left ? left.split(":") : [];
  const rightParts = right ? right.split(":") : [];
  if (!address.includes("::") && leftParts.length !== 8) return null;
  const fill = 8 - leftParts.length - rightParts.length;
  if (fill < 0) return null;
  const parts = [...leftParts, ...Array(fill).fill("0"), ...rightParts];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.map((part) => Number.parseInt(part, 16));
}

function ipv6IsPublic(address) {
  const parts = expandIpv6(address);
  if (!parts) return false;
  const isMappedIpv4 = parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff;
  if (isMappedIpv4) {
    return ipv4IsPublic(`${parts[6] >> 8}.${parts[6] & 255}.${parts[7] >> 8}.${parts[7] & 255}`);
  }
  return parts[0] >= 0x2000 && parts[0] <= 0x3fff && !(parts[0] === 0x2001 && parts[1] === 0x0db8);
}

function ipIsPublic(address) {
  const family = isIP(address);
  if (family === 4) return ipv4IsPublic(address);
  if (family === 6) return ipv6IsPublic(address);
  return false;
}

export async function assertPublicTargetUrl(value, options = {}) {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new TypeError("Public research targets must use HTTPS");
  }
  if (url.username || url.password) {
    throw new TypeError("Public research target URLs must not contain credentials");
  }
  if ([...url.searchParams.keys()].some(isCredentialQueryParameter)) {
    throw new TypeError("Public research target query parameters must not contain credentials");
  }
  url.hash = "";
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const address = hostname.replace(/^\[|\]$/g, "");
  const family = isIP(address);
  if (family) {
    if (!ipIsPublic(address)) throw new TypeError("Public research targets must use a public IP address");
    return url;
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || !hostname.includes(".")) {
    throw new TypeError("Public research targets must use a public host name");
  }
  const lookup = options.lookup ?? systemLookup;
  const records = await lookup(hostname, { all: true, verbatim: true });
  if (!Array.isArray(records) || records.length === 0) {
    throw new TypeError(`Public research target host ${hostname} did not resolve`);
  }
  if (records.some((record) => !ipIsPublic(String(record?.address ?? "")))) {
    throw new TypeError(`Public research target host ${hostname} resolved to a non-public IP address`);
  }
  return url;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function createPublicFetch(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const lookup = options.lookup ?? systemLookup;
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("Public fetch timeout must be a positive number");

  return async function publicFetch(value, requestOptions = {}) {
    const method = String(requestOptions.method ?? "GET").toUpperCase();
    if (!["GET", "HEAD"].includes(method)) {
      throw new TypeError("Public research fetching is read-only and only supports GET or HEAD");
    }
    let current = new URL(value);
    let currentOptions = { ...requestOptions };
    const deadline = Date.now() + timeoutMs;
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      current = await assertPublicTargetUrl(current, { lookup });
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Public fetch exceeded its ${timeoutMs}ms deadline`);
      const controller = new AbortController();
      const callerSignal = currentOptions.signal;
      const forwardAbort = () => controller.abort(callerSignal.reason);
      if (callerSignal?.aborted) forwardAbort();
      else callerSignal?.addEventListener("abort", forwardAbort, { once: true });
      const timer = setTimeout(() => controller.abort(new Error(`Public fetch exceeded its ${timeoutMs}ms deadline`)), remaining);
      let response;
      try {
        response = await fetchImpl(current.href, { ...currentOptions, signal: controller.signal, redirect: "manual" });
      } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener?.("abort", forwardAbort);
      }
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      if (redirectCount === maxRedirects) throw new Error(`Public fetch exceeded ${maxRedirects} redirects`);
      const location = response.headers.get("location");
      if (!location) throw new Error(`HTTP ${response.status} response did not include a redirect location`);
      const next = new URL(location, current);
      if (next.origin !== current.origin && currentOptions.headers) {
        const headers = new Headers(currentOptions.headers);
        headers.delete("authorization");
        headers.delete("cookie");
        headers.delete("proxy-authorization");
        currentOptions = { ...currentOptions, headers };
      }
      if (response.status === 303 && String(currentOptions.method ?? "GET").toUpperCase() !== "HEAD") {
        const { body: _body, ...withoutBody } = currentOptions;
        currentOptions = { ...withoutBody, method: "GET" };
      }
      current = next;
    }
    throw new Error("Public fetch redirect handling failed");
  };
}
