#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertMeaningfulScreenshot, inspectPng } from "./png-evidence.mjs";
import { attestPlaywrightRuntime } from "./playwright-runtime-attestation.mjs";

const REPRESENTATIVE_VIEWPORTS = Object.freeze([
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 }
]);

const DEFAULT_MINIMUM_VIEWPORT_WIDTH = 320;
const DEFAULT_MAXIMUM_VIEWPORT_WIDTH = 1600;
const DEFAULT_BOUNDARY_HEIGHT = 900;
const PLAYWRIGHT_CORE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../node_modules/playwright-core"
);
const PLAYWRIGHT_BROWSERS_MANIFEST = path.join(PLAYWRIGHT_CORE_ROOT, "browsers.json");

function sha256(filePath) {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

export { assertMeaningfulScreenshot, inspectPng };

export function isAllowedReportRequest(requestUrl, reportUrl) {
  let parsed;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return false;
  }
  if (parsed.protocol === "data:" || parsed.protocol === "blob:") return true;
  if (parsed.protocol !== "file:") return false;
  const request = new URL(requestUrl);
  const report = new URL(reportUrl);
  request.hash = "";
  report.hash = "";
  return request.href === report.href;
}

export function createCaptureNetworkPolicy(reportUrl) {
  return Object.freeze({
    allowsHttpRequest(requestUrl) {
      return isAllowedReportRequest(requestUrl, reportUrl);
    },
    allowsWebSocket() {
      return false;
    },
    descriptor: Object.freeze({
      http: "exact_report_file_and_embedded_data_only",
      websocket: "blocked",
      service_worker: "blocked"
    })
  });
}

export function assertSelfContainedStylesheets(htmlSource) {
  if (typeof htmlSource !== "string") throw new Error("HTML source must be a string");
  if (/<link\b(?=[^>]*\brel\s*=\s*(?:["']stylesheet["']|stylesheet\b))[^>]*>/iu.test(htmlSource)) {
    throw new Error("Linked stylesheets are unsupported for responsive capture; inline the CSS so every breakpoint can be audited");
  }
}

export function discoverCssBreakpoints(cssSources, {
  minimumWidth = DEFAULT_MINIMUM_VIEWPORT_WIDTH,
  maximumWidth = DEFAULT_MAXIMUM_VIEWPORT_WIDTH,
  rootFontSize = 16
} = {}) {
  if (!Array.isArray(cssSources)) throw new Error("CSS sources must be an array");
  if (!(minimumWidth > 0 && maximumWidth >= minimumWidth && rootFontSize > 0)) {
    throw new Error("Responsive breakpoint bounds are invalid");
  }
  const widths = new Set();
  const mediaPrelude = /@media\b([^{}]*)\{/gi;
  const widthConditions = [
    { pattern: /\((?:min|max)-width\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*(px|rem|em)\s*\)/gi, pairs: [[1, 2]] },
    { pattern: /\(\s*width\s*(?:<=|>=|<|>)\s*([0-9]+(?:\.[0-9]+)?)\s*(px|rem|em)\s*\)/gi, pairs: [[1, 2]] },
    { pattern: /\(\s*([0-9]+(?:\.[0-9]+)?)\s*(px|rem|em)\s*(?:<=|>=|<|>)\s*width\s*\)/gi, pairs: [[1, 2]] },
    {
      pattern: /\(\s*([0-9]+(?:\.[0-9]+)?)\s*(px|rem|em)\s*(?:<=|<)\s*width\s*(?:<=|<)\s*([0-9]+(?:\.[0-9]+)?)\s*(px|rem|em)\s*\)/gi,
      pairs: [[1, 2], [3, 4]]
    },
    {
      pattern: /\(\s*([0-9]+(?:\.[0-9]+)?)\s*(px|rem|em)\s*(?:>=|>)\s*width\s*(?:>=|>)\s*([0-9]+(?:\.[0-9]+)?)\s*(px|rem|em)\s*\)/gi,
      pairs: [[1, 2], [3, 4]]
    }
  ];
  for (const source of cssSources) {
    if (typeof source !== "string") continue;
    if (/@container\b[^{}]*\bwidth\b/iu.test(source)) {
      throw new Error("Container width queries are unsupported by viewport breakpoint discovery and require a separate explicit test");
    }
    for (const mediaMatch of source.matchAll(mediaPrelude)) {
      const prelude = mediaMatch[1];
      const widthReferenceCount = prelude.match(/\bwidth\b/giu)?.length ?? 0;
      let matchedWidthConditionCount = 0;
      for (const condition of widthConditions) {
        for (const match of prelude.matchAll(condition.pattern)) {
          matchedWidthConditionCount += 1;
          for (const [numberIndex, unitIndex] of condition.pairs) {
            const numeric = Number(match[numberIndex]);
            const unit = match[unitIndex].toLowerCase();
            const pixels = Math.round(unit === "px" ? numeric : numeric * rootFontSize);
            if (pixels >= minimumWidth && pixels <= maximumWidth) widths.add(pixels);
          }
        }
      }
      if (widthReferenceCount !== matchedWidthConditionCount) {
        throw new Error(`Unsupported @media width syntax: ${prelude.trim()}`);
      }
    }
  }
  return [...widths].sort((left, right) => left - right);
}

export function buildResponsiveViewportMatrix({
  representativeViewports = REPRESENTATIVE_VIEWPORTS,
  breakpoints = [],
  minimumWidth = DEFAULT_MINIMUM_VIEWPORT_WIDTH,
  maximumWidth = DEFAULT_MAXIMUM_VIEWPORT_WIDTH,
  boundaryDelta = 1,
  boundaryHeight = DEFAULT_BOUNDARY_HEIGHT
} = {}) {
  if (!Array.isArray(representativeViewports) || !representativeViewports.length) {
    throw new Error("At least one representative viewport is required");
  }
  if (!Number.isInteger(boundaryDelta) || boundaryDelta < 1 || !Number.isInteger(boundaryHeight) || boundaryHeight < 1) {
    throw new Error("Responsive boundary dimensions are invalid");
  }
  const byWidth = new Map();
  for (const viewport of representativeViewports) {
    if (!Number.isInteger(viewport.width) || !Number.isInteger(viewport.height)) {
      throw new Error("Representative viewport dimensions must be integers");
    }
    if (viewport.width < minimumWidth || viewport.width > maximumWidth) continue;
    byWidth.set(viewport.width, {
      ...viewport,
      coverage_mode: "full_tiling",
      breakpoint: null,
      boundary_position: null
    });
  }
  const normalisedBreakpoints = [...new Set(breakpoints
    .filter(Number.isFinite)
    .map((width) => Math.round(width))
    .filter((width) => width >= minimumWidth && width <= maximumWidth))]
    .sort((left, right) => left - right);
  for (const breakpoint of normalisedBreakpoints) {
    for (const [boundaryPosition, width] of [
      ["below", breakpoint - boundaryDelta],
      ["at", breakpoint],
      ["above", breakpoint + boundaryDelta]
    ]) {
      if (width < minimumWidth || width > maximumWidth || byWidth.has(width)) continue;
      byWidth.set(width, {
        name: `boundary-${width}`,
        width,
        height: boundaryHeight,
        coverage_mode: "boundary_dom_interaction",
        breakpoint,
        boundary_position: boundaryPosition
      });
      if (byWidth.size > 100) {
        throw new Error("Responsive viewport matrix exceeds the 100-viewport QA bound");
      }
    }
  }
  return [...byWidth.values()].sort((left, right) => left.width - right.width);
}

export function buildTilePositions(documentHeight, viewportHeight, overlap = 96) {
  if (!Number.isFinite(documentHeight) || documentHeight <= 0) throw new Error("Document height must be positive");
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) throw new Error("Viewport height must be positive");
  const maxScroll = Math.max(0, Math.ceil(documentHeight - viewportHeight));
  const step = Math.max(1, Math.floor(viewportHeight - Math.min(overlap, viewportHeight - 1)));
  const positions = [0];
  while (positions.at(-1) < maxScroll) {
    if (positions.length >= 200) throw new Error("Document requires more than the 200-tile visual QA bound");
    const next = Math.min(maxScroll, positions.at(-1) + step);
    if (next === positions.at(-1)) break;
    positions.push(next);
  }
  return positions;
}

function defaultBrowserCacheRoots(platform = process.platform) {
  return platform === "darwin"
    ? [path.join(os.homedir(), "Library/Caches/ms-playwright"), path.join(os.homedir(), ".cache/ms-playwright")]
    : [path.join(os.homedir(), ".cache/ms-playwright")];
}

function browserExecutableSuffixes(platform = process.platform, architecture = process.arch) {
  if (platform === "darwin") {
    const preferred = architecture === "arm64" ? "mac-arm64" : "mac-x64";
    return [
      `chrome-headless-shell-${preferred}/chrome-headless-shell`,
      "chrome-headless-shell-mac/chrome-headless-shell"
    ];
  }
  if (platform === "win32") return ["chrome-headless-shell-win64/chrome-headless-shell.exe"];
  return ["chrome-headless-shell-linux64/chrome-headless-shell"];
}

function readPlaywrightBrowsersManifest(manifestPath = PLAYWRIGHT_BROWSERS_MANIFEST) {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function pinnedHeadlessShellRevision(browsersManifest) {
  const entry = browsersManifest?.browsers?.find((browser) => browser.name === "chromium-headless-shell");
  if (!entry || !/^\d+$/.test(String(entry.revision ?? ""))) {
    throw new Error("playwright-core does not declare a pinned chromium-headless-shell revision");
  }
  return String(entry.revision);
}

export function resolveBrowser({
  cacheRoots = defaultBrowserCacheRoots(),
  platform = process.platform,
  architecture = process.arch,
  configuredExecutable = process.env.CHROMIUM_EXECUTABLE_PATH?.trim() || null,
  browsersManifest = readPlaywrightBrowsersManifest()
} = {}) {
  const revision = pinnedHeadlessShellRevision(browsersManifest);
  const candidates = [];
  if (configuredExecutable) {
    const configuredPath = path.resolve(configuredExecutable);
    const revisionPattern = new RegExp(`(?:^|[\\/])chromium[_-]headless[_-]shell-${revision}(?:[\\/]|$)`);
    if (!revisionPattern.test(configuredPath)) {
      throw new Error(`Configured Chromium is not the playwright-core pinned headless-shell revision ${revision}`);
    }
    candidates.push(configuredPath);
  }
  for (const root of cacheRoots) {
    for (const directory of [`chromium_headless_shell-${revision}`, `chromium-headless-shell-${revision}`]) {
      for (const suffix of browserExecutableSuffixes(platform, architecture)) {
        candidates.push(path.join(root, directory, suffix));
      }
    }
  }
  const executable = [...new Set(candidates)].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!executable) {
    throw new Error(
      `The chromium-headless-shell revision ${revision} pinned by playwright-core is not installed. ` +
      "During approved environment setup run: " +
      "npx --yes playwright-core@1.61.1 install --only-shell chromium"
    );
  }
  return executable;
}

export async function waitForDocumentReadiness(sample, {
  maxAttempts = 10,
  requiredStableSamples = 3,
  delayMs = 200
} = {}) {
  if (typeof sample !== "function") throw new Error("Document readiness sampler must be a function");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts must be a positive integer");
  if (!Number.isInteger(requiredStableSamples) || requiredStableSamples < 1 || requiredStableSamples > maxAttempts) {
    throw new Error("requiredStableSamples must fit within maxAttempts");
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("delayMs must not be negative");
  let prior;
  let stableSamples = 0;
  for (let attempts = 1; attempts <= maxAttempts; attempts += 1) {
    const observation = await sample();
    const serialised = JSON.stringify(observation);
    if (serialised === prior) stableSamples += 1;
    else stableSamples = 1;
    prior = serialised;
    if (stableSamples >= requiredStableSamples) {
      return { attempts, stable_samples: stableSamples, observation };
    }
    if (attempts < maxAttempts && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`Document did not converge after ${maxAttempts} observations`);
}

function compactChartLabel(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, "").trim();
}

function normaliseChartLabel(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function normaliseRectangle(value) {
  if (!value || typeof value !== "object") return null;
  const rectangle = Object.fromEntries(
    ["left", "right", "top", "bottom"].map((key) => [key, Number(value[key])])
  );
  return Object.values(rectangle).every(Number.isFinite) && rectangle.right >= rectangle.left && rectangle.bottom >= rectangle.top
    ? rectangle
    : null;
}

function rectanglesOverlap(left, right, tolerance = 1) {
  return Math.min(left.right, right.right) - Math.max(left.left, right.left) > tolerance &&
    Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > tolerance;
}

function rectangleExceedsClip(rectangle, clip, tolerance = 1) {
  return (clip.clip_x !== false && (rectangle.left < clip.left - tolerance || rectangle.right > clip.right + tolerance)) ||
    (clip.clip_y !== false && (rectangle.top < clip.top - tolerance || rectangle.bottom > clip.bottom + tolerance));
}

export function assessChartTextIntegrity(charts, {
  maximumIssues = 50,
  maximumRequiredCategories = 12,
} = {}) {
  if (!Array.isArray(charts)) throw new Error("Chart text records must be an array");
  if (!Number.isInteger(maximumIssues) || maximumIssues < 1 || maximumIssues > 500) {
    throw new Error("maximumIssues must be an integer from 1 to 500");
  }
  if (!Number.isInteger(maximumRequiredCategories) || maximumRequiredCategories < 1 || maximumRequiredCategories > 100) {
    throw new Error("maximumRequiredCategories must be an integer from 1 to 100");
  }
  let inspectedTickCount = 0;
  let matchedCategoryTickCount = 0;
  let truncatedLabelCount = 0;
  let midWordWrapCount = 0;
  let omittedCategoryCount = 0;
  let fallbackBindingFailureCount = 0;
  let clippedLabelCount = 0;
  let overlappingLabelCount = 0;
  const omittedCategories = [];
  const issues = [];

  const recordIssue = (issue) => {
    if (issues.length < maximumIssues) issues.push(issue);
  };

  for (let chartIndex = 0; chartIndex < charts.length; chartIndex += 1) {
    const chart = charts[chartIndex] ?? {};
    const chartId = normaliseChartLabel(chart.chart_id) || `chart-${chartIndex + 1}`;
    const categories = Array.isArray(chart.categories)
      ? [...new Set(chart.categories.map(normaliseChartLabel).filter(Boolean))]
      : [];
    const categoryByCompactLabel = new Map(categories.map((category) => [compactChartLabel(category), category]));
    const representedCategories = new Set();
    const matchedTickGeometries = [];
    const ticks = Array.isArray(chart.ticks) ? chart.ticks : [];
    if (ticks.length > 10_000 || categories.length > 10_000) {
      throw new Error(`${chartId} exceeds the 10,000-label chart text QA bound`);
    }
    const fallbackContract = chart.fallback_contract && typeof chart.fallback_contract === "object"
      ? chart.fallback_contract
      : {};
    const fallbackBindingFailed = fallbackContract.expected === true &&
      (fallbackContract.identity_found !== true || fallbackContract.table_found !== true);
    const fallbackDataMalformed = Number.isInteger(fallbackContract.row_count) &&
      fallbackContract.row_count > 0 && categories.length === 0;
    if (fallbackBindingFailed || fallbackDataMalformed) {
      fallbackBindingFailureCount += 1;
      recordIssue({
        chart_id: chartId,
        label: "",
        visible_lines: [],
        reason: fallbackBindingFailed
          ? "Portable chart has no stable category evidence bound from its fallback data"
          : "Portable chart fallback data contains rows but exposes no category evidence",
      });
    }

    for (const tick of ticks) {
      inspectedTickCount += 1;
      const lines = (Array.isArray(tick?.lines) ? tick.lines : [])
        .map(normaliseChartLabel)
        .filter(Boolean);
      const title = normaliseChartLabel(tick?.title);
      const visibleLabel = lines.join(" ");
      const visibleCompact = compactChartLabel(lines.join(""));
      const fullLabel = categories.includes(title)
        ? title
        : categoryByCompactLabel.get(visibleCompact) ?? "";
      if (fullLabel) {
        representedCategories.add(fullLabel);
        matchedCategoryTickCount += 1;
        const rectangle = normaliseRectangle(tick?.rect);
        const clippingRectangles = (Array.isArray(tick?.clipping_rects) ? tick.clipping_rects : [])
          .map((value) => {
            const rectangleValue = normaliseRectangle(value);
            return rectangleValue ? {
              ...rectangleValue,
              clip_x: value?.clip_x !== false,
              clip_y: value?.clip_y !== false,
            } : null;
          })
          .filter(Boolean);
        if (rectangle) {
          matchedTickGeometries.push({ label: fullLabel, rectangle });
          if (clippingRectangles.some((clip) => rectangleExceedsClip(rectangle, clip))) {
            clippedLabelCount += 1;
            recordIssue({
              chart_id: chartId,
              label: fullLabel,
              visible_lines: lines,
              reason: "Category-axis label is clipped by an overflow boundary",
            });
          }
        }
      }
      const hasEllipsis = lines.some((line) => /(?:\u2026|\.\.\.)/u.test(line));
      const titleShowsLoss = Boolean(
        title && categories.includes(title) && visibleCompact !== compactChartLabel(title)
      );

      if (hasEllipsis || titleShowsLoss) {
        truncatedLabelCount += 1;
        recordIssue({
          chart_id: chartId,
          label: fullLabel || title || visibleLabel,
          visible_lines: lines,
          reason: "Category-axis label is truncated",
        });
        continue;
      }

      if (!fullLabel) continue;
      if (lines.length < 2) continue;

      const words = fullLabel.split(/\s+/u).map(compactChartLabel).filter(Boolean);
      const allowedBoundaries = new Set();
      let wordOffset = 0;
      for (const word of words.slice(0, -1)) {
        wordOffset += word.length;
        allowedBoundaries.add(wordOffset);
      }
      let lineOffset = 0;
      const observedBoundaries = [];
      for (const line of lines.slice(0, -1)) {
        lineOffset += compactChartLabel(line).length;
        observedBoundaries.push(lineOffset);
      }
      const badBoundary = observedBoundaries.find((boundary) => !allowedBoundaries.has(boundary));
      if (badBoundary != null) {
        midWordWrapCount += 1;
        recordIssue({
          chart_id: chartId,
          label: fullLabel,
          visible_lines: lines,
          reason: `Category-axis label wraps inside a word at character ${badBoundary}`,
        });
      }
    }

    if (categories.length > 0 && categories.length <= maximumRequiredCategories) {
      const omitted = categories.filter((category) => !representedCategories.has(category));
      if (omitted.length) {
        omittedCategoryCount += omitted.length;
        omittedCategories.push(...omitted);
        recordIssue({
          chart_id: chartId,
          label: omitted.join(", "),
          visible_lines: [],
          reason: `Small categorical chart omitted ${omitted.length} category label${omitted.length === 1 ? "" : "s"}`,
        });
      }
      for (let leftIndex = 0; leftIndex < matchedTickGeometries.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < matchedTickGeometries.length; rightIndex += 1) {
          const left = matchedTickGeometries[leftIndex];
          const right = matchedTickGeometries[rightIndex];
          if (!rectanglesOverlap(left.rectangle, right.rectangle)) continue;
          overlappingLabelCount += 1;
          recordIssue({
            chart_id: chartId,
            label: `${left.label} / ${right.label}`,
            visible_lines: [],
            reason: "Category-axis labels overlap",
          });
        }
      }
    }
  }

  const issueCount = fallbackBindingFailureCount + truncatedLabelCount + midWordWrapCount + omittedCategoryCount +
    clippedLabelCount + overlappingLabelCount;
  return {
    status: issueCount ? "failed" : "passed",
    inspected_chart_count: charts.length,
    inspected_tick_count: inspectedTickCount,
    matched_category_tick_count: matchedCategoryTickCount,
    fallback_binding_failure_count: fallbackBindingFailureCount,
    truncated_label_count: truncatedLabelCount,
    mid_word_wrap_count: midWordWrapCount,
    omitted_category_count: omittedCategoryCount,
    omitted_categories: omittedCategories,
    clipped_label_count: clippedLabelCount,
    overlapping_label_count: overlappingLabelCount,
    issue_count: issueCount,
    issues,
    issues_truncated: issueCount > issues.length,
  };
}

function parseArgs(argv) {
  const options = {};
  const supported = new Set(["html", "out-dir", "receipt", "run-id", "builder-receipt"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true };
    if (!token.startsWith("--") || !supported.has(token.slice(2))) throw new Error(`Unknown argument: ${token}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`${token} requires a value`);
    options[token.slice(2)] = value;
    index += 1;
  }
  if (!options.html || !options["out-dir"] || !options.receipt || !options["run-id"] || !options["builder-receipt"]) {
    throw new Error("--html, --out-dir, --receipt, --run-id and --builder-receipt are required");
  }
  return {
    html: path.resolve(options.html),
    outDir: path.resolve(options["out-dir"]),
    receipt: path.resolve(options.receipt),
    runId: options["run-id"],
    builderReceipt: path.resolve(options["builder-receipt"])
  };
}

async function settlePage(page) {
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

export async function resetDocumentScrollForFullPage(page) {
  const scrollY = await page.evaluate(async () => {
    window.scrollTo(0, 0);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return window.scrollY;
  });
  if (scrollY !== 0) throw new Error(`document remained at scroll position ${scrollY} before full-page capture`);
  return scrollY;
}

async function sampleDocumentReadiness(page) {
  return page.evaluate(() => {
    const scrolling = document.scrollingElement;
    const visibleText = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    return {
      scroll_height: scrolling?.scrollHeight ?? 0,
      scroll_width: scrolling?.scrollWidth ?? 0,
      client_width: scrolling?.clientWidth ?? 0,
      visible_text_characters: visibleText.length,
      block_count: Array.from(document.querySelectorAll(
        "#data-analytics-portable-reader [data-artifact-block-id], #data-analytics-portable-reader .portable-block"
      )).filter(visible).length,
      table_count: Array.from(document.querySelectorAll(
        "#data-analytics-portable-reader .table-wrap, #data-analytics-portable-reader .portable-table-scroll"
      )).filter(visible).length,
      chart_count: Array.from(document.querySelectorAll(
        "#data-analytics-portable-reader .recharts-wrapper, #data-analytics-portable-reader .portable-chart-summary"
      )).filter(visible).length
    };
  });
}

async function extractChartTextRecords(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const reader = document.getElementById("data-analytics-portable-reader");
    const fallback = document.getElementById("data-analytics-portable-fallback");
    const wrappers = Array.from((reader ?? document).querySelectorAll(".recharts-wrapper")).filter(visible);
    const roots = [];
    for (const wrapper of wrappers) {
      const root = wrapper.closest("[data-chart-id], [data-artifact-id][data-artifact-kind='chart'], figure") ?? wrapper;
      if (!roots.includes(root)) roots.push(root);
    }
    return roots.map((root, index) => {
      const chartId = root.getAttribute("data-chart-id")
        ?? root.getAttribute("data-artifact-id")
        ?? root.id
        ?? root.closest("[data-chart-id], [data-artifact-id]")?.getAttribute("data-chart-id")
        ?? root.closest("[data-artifact-id]")?.getAttribute("data-artifact-id")
        ?? `chart-${index + 1}`;
      const escapedChartId = CSS.escape(chartId);
      const fallbackRoot = fallback?.querySelector(
        `[data-chart-id="${escapedChartId}"], [data-artifact-id="${escapedChartId}"]`
      ) ?? null;
      const liveTable = root.querySelector(".portable-chart-data table");
      const fallbackTable = fallbackRoot?.querySelector(".portable-chart-data table") ?? null;
      const dataTable = liveTable ?? fallbackTable;
      const dataRows = dataTable ? Array.from(dataTable.querySelectorAll("tbody tr")) : [];
      const categories = dataTable
        ? dataRows
          .map((row) => row.querySelector("td")?.textContent?.replace(/\s+/gu, " ").trim() ?? "")
          .filter(Boolean)
        : [];
      const ticks = Array.from(root.querySelectorAll(".recharts-cartesian-axis-tick-value")).filter(visible).map((tick) => {
        const tspans = Array.from(tick.querySelectorAll(":scope > tspan"));
        const lines = (tspans.length ? tspans : [tick])
          .map((line) => line.childNodes.length
            ? Array.from(line.childNodes)
              .filter((node) => node.nodeType === Node.TEXT_NODE)
              .map((node) => node.textContent ?? "")
              .join("")
            : line.textContent ?? "")
          .map((line) => line.replace(/\s+/gu, " ").trim())
          .filter(Boolean);
        const tickRect = tick.getBoundingClientRect();
        const clippingRects = [];
        for (let ancestor = tick.parentElement; ancestor && root.contains(ancestor); ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          const clipX = ["hidden", "clip"].includes(style.overflowX);
          const clipY = ["hidden", "clip"].includes(style.overflowY);
          if (clipX || clipY) {
            const rect = ancestor.getBoundingClientRect();
            clippingRects.push({
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
              clip_x: clipX,
              clip_y: clipY,
            });
          }
          if (ancestor === root) break;
        }
        return {
          lines,
          title: tick.querySelector(":scope > title")?.textContent?.replace(/\s+/gu, " ").trim() ?? "",
          rect: { left: tickRect.left, right: tickRect.right, top: tickRect.top, bottom: tickRect.bottom },
          clipping_rects: clippingRects,
        };
      });
      return {
        chart_id: chartId,
        fallback_contract: {
          expected: Boolean(reader && fallback),
          identity_found: Boolean(fallbackRoot),
          table_found: Boolean(dataTable),
          row_count: dataRows.length,
        },
        categories,
        ticks,
      };
    });
  });
}

async function waitForStableRenderedDocument(page) {
  return waitForDocumentReadiness(async () => {
    await settlePage(page);
    await exerciseFullDocument(page);
    return sampleDocumentReadiness(page);
  }, {
    maxAttempts: 10,
    requiredStableSamples: 3,
    delayMs: 200
  });
}

async function exerciseFullDocument(page) {
  await page.evaluate(async () => {
    const scrolling = document.scrollingElement;
    if (!scrolling) return;
    const maximumDocumentHeight = 5_000_000;
    const maximumTraversalSteps = 20_000;
    if (scrolling.scrollHeight > maximumDocumentHeight) {
      throw new Error(`Document height ${scrolling.scrollHeight}px exceeds the ${maximumDocumentHeight}px QA bound`);
    }
    const step = Math.max(1, window.innerHeight - 80);
    let traversalSteps = 0;
    for (let offset = 0; offset < scrolling.scrollHeight; offset += step) {
      traversalSteps += 1;
      if (traversalSteps > maximumTraversalSteps) throw new Error("Document traversal exceeded its step bound");
      window.scrollTo(0, offset);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    window.scrollTo(0, 0);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

function screenshotRecord(outputPath, name, viewport, scheme, captureKind, metadata = {}) {
  const metrics = inspectPng(outputPath);
  if (captureKind.startsWith("viewport_")) {
    assertMeaningfulScreenshot(metrics, viewport);
  } else {
    if (metrics.width !== viewport.width || metrics.height < viewport.height) {
      throw new Error(
        `Full-page screenshot dimensions ${metrics.width}x${metrics.height} do not cover ` +
        `${viewport.width}x${viewport.height}`
      );
    }
    assertMeaningfulScreenshot(metrics, { width: metrics.width, height: metrics.height });
  }
  return {
    name,
    path: outputPath,
    capture_kind: captureKind,
    viewport_width: viewport.width,
    viewport_height: viewport.height,
    width: metrics.width,
    height: metrics.height,
    colour_scheme: scheme,
    sha256: sha256(outputPath),
    size_bytes: fs.statSync(outputPath).size,
    visual_metrics: metrics,
    ...metadata
  };
}

async function exerciseTableScrollers(page) {
  return page.evaluate(async () => {
    const waitFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const tables = Array.from(document.querySelectorAll(
      "#data-analytics-portable-reader .table-wrap, #data-analytics-portable-reader .portable-table-scroll"
    )).filter((table) => {
      const rect = table.getBoundingClientRect();
      const style = getComputedStyle(table);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
    const results = [];
    for (let index = 0; index < tables.length; index += 1) {
      const table = tables[index];
      const rect = table.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      table.scrollLeft = 0;
      await waitFrame();
      const leftEdge = table.scrollLeft;
      const maxScroll = Math.max(0, table.scrollWidth - table.clientWidth);
      table.scrollLeft = maxScroll;
      await waitFrame();
      const rightEdge = table.scrollLeft;
      const reachedRightEdge = maxScroll === 0 || Math.abs(rightEdge - maxScroll) <= 1;
      table.scrollLeft = 0;
      await waitFrame();
      results.push({
        index,
        visible,
        client_width: table.clientWidth,
        scroll_width: table.scrollWidth,
        max_scroll: maxScroll,
        left_edge: leftEdge,
        right_edge: rightEdge,
        overflow: maxScroll > 1,
        moved: maxScroll <= 1 || rightEdge > leftEdge + 1,
        reached_right_edge: reachedRightEdge,
        returned_left_edge: Math.abs(table.scrollLeft) <= 1
      });
    }
    return results;
  });
}

async function captureTableRightEdge(page, tableIndex, stickyHeaderHeight, viewportHeight) {
  return page.evaluate(async ({ tableIndex: index, stickyHeader, height }) => {
    const waitFrames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const tables = Array.from(document.querySelectorAll(
      "#data-analytics-portable-reader .table-wrap, #data-analytics-portable-reader .portable-table-scroll"
    )).filter((table) => {
      const rect = table.getBoundingClientRect();
      const style = getComputedStyle(table);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
    const table = tables[index];
    if (!table) throw new Error(`table ${index} disappeared before right-edge capture`);
    const initialRect = table.getBoundingClientRect();
    const documentTop = initialRect.top + window.scrollY;
    const documentBottom = initialRect.bottom + window.scrollY;
    const scrolling = document.scrollingElement;
    const maximumPageScroll = Math.max(0, (scrolling?.scrollHeight ?? height) - height);
    const desiredPageScroll = Math.min(
      maximumPageScroll,
      Math.max(0, Math.floor(documentTop - stickyHeader - 16))
    );
    window.scrollTo(0, desiredPageScroll);
    await waitFrames();
    const maxScroll = Math.max(0, table.scrollWidth - table.clientWidth);
    table.scrollLeft = maxScroll;
    await waitFrames();
    const rect = table.getBoundingClientRect();
    return {
      table_index: index,
      page_scroll_y: window.scrollY,
      table_scroll_left: table.scrollLeft,
      max_scroll: maxScroll,
      table_document_top: documentTop,
      table_document_bottom: documentBottom,
      table_viewport_top: rect.top,
      table_viewport_bottom: rect.bottom,
      table_visible_in_viewport: rect.bottom > stickyHeader && rect.top < height,
      reached_right_edge: maxScroll > 1 && Math.abs(table.scrollLeft - maxScroll) <= 1
    };
  }, { tableIndex, stickyHeader: stickyHeaderHeight, height: viewportHeight });
}

async function resetTableScroll(page, tableIndex) {
  await page.evaluate(async (index) => {
    const tables = Array.from(document.querySelectorAll(
      "#data-analytics-portable-reader .table-wrap, #data-analytics-portable-reader .portable-table-scroll"
    )).filter((table) => {
      const rect = table.getBoundingClientRect();
      const style = getComputedStyle(table);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
    if (tables[index]) tables[index].scrollLeft = 0;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }, tableIndex);
}

async function capture(browser, htmlUrl, outDir, viewport, scheme) {
  const failures = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const baseName = `${viewport.name}-${scheme}`;
    const fullPath = path.join(outDir, `${baseName}-full.png`);
    for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith(`${baseName}-`) && entry.name.endsWith(".png")) {
        fs.rmSync(path.join(outDir, entry.name), { force: true });
      }
    }
    const externalRequests = [];
    const externalWebSockets = [];
    const pageErrors = [];
    const consoleErrors = [];
    const networkPolicy = createCaptureNetworkPolicy(htmlUrl);
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      colorScheme: scheme,
      reducedMotion: "reduce",
      deviceScaleFactor: 1,
      serviceWorkers: "block"
    });
    try {
      await context.route("**/*", async (route) => {
        const requestUrl = route.request().url();
        if (networkPolicy.allowsHttpRequest(requestUrl)) await route.continue();
        else {
          externalRequests.push(requestUrl);
          await route.abort("blockedbyclient");
        }
      });
      await context.routeWebSocket(/.*/, async (webSocket) => {
        const requestUrl = webSocket.url();
        externalWebSockets.push(requestUrl);
        await webSocket.close({ code: 1008, reason: "Blocked by visual QA network policy" });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      page.setDefaultNavigationTimeout(20_000);
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      await page.goto(htmlUrl, { waitUntil: "load", timeout: 20_000 });
      const portable = await page.evaluate(() =>
        document.documentElement.hasAttribute("data-data-analytics-portable-artifact")
      );
      if (portable) {
        await page.waitForFunction(
          () => document.documentElement.dataset.dataAnalyticsPortableReader === "ready",
          undefined,
          { timeout: 15_000 }
        );
      }
      const renderConvergence = await waitForStableRenderedDocument(page);
      const chartTextIntegrity = assessChartTextIntegrity(await extractChartTextRecords(page));
      if (chartTextIntegrity.status !== "passed") {
        const summary = chartTextIntegrity.issues
          .map((issue) => `${issue.chart_id}: ${issue.label} (${issue.reason})`)
          .join(" | ");
        throw new Error(`chart text integrity failed: ${summary}`);
      }
      const tableScrollChecks = await exerciseTableScrollers(page);
      const dom = await page.evaluate(() => {
        const scrolling = document.scrollingElement;
        const reader = document.getElementById("data-analytics-portable-reader");
        const readerRect = reader?.getBoundingClientRect();
        const visibleText = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim();
        const header = document.querySelector(
          "#data-analytics-portable-reader .analytics-top-bar, #data-analytics-portable-reader .portable-page-header"
        );
        const headerStyle = header ? getComputedStyle(header) : null;
        const blockGeometries = Array.from(document.querySelectorAll(
          "#data-analytics-portable-reader [data-artifact-block-id], #data-analytics-portable-reader .portable-block"
        ))
          .map((block, index) => {
            const rect = block.getBoundingClientRect();
            return {
              index,
              top: rect.top + window.scrollY,
              bottom: rect.bottom + window.scrollY,
              width: rect.width,
              height: rect.height
            };
          })
          .filter((block) => block.width > 0 && block.height > 0);
        return {
          document_state: document.readyState,
          reader_state: document.documentElement.dataset.dataAnalyticsPortableReader ?? "not_applicable",
          reader_visible: reader
            ? reader.getAttribute("aria-hidden") !== "true" && Boolean(readerRect && readerRect.width > 0 && readerRect.height > 0)
            : null,
          visible_text_characters: visibleText.length,
          viewport_width: window.innerWidth,
          viewport_height: window.innerHeight,
          scroll_width: scrolling?.scrollWidth ?? 0,
          client_width: scrolling?.clientWidth ?? 0,
          scroll_height: scrolling?.scrollHeight ?? 0,
          sticky_header_height: headerStyle && ["sticky", "fixed"].includes(headerStyle.position)
            ? header?.getBoundingClientRect().height ?? 0
            : 0,
          block_count: blockGeometries.length,
          block_geometries: blockGeometries,
          chart_count: Array.from(document.querySelectorAll(
            "#data-analytics-portable-reader .recharts-wrapper, #data-analytics-portable-reader .portable-chart-summary"
          )).filter((chart) => {
            const rect = chart.getBoundingClientRect();
            const style = getComputedStyle(chart);
            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          }).length,
          table_count: Array.from(document.querySelectorAll(
            "#data-analytics-portable-reader .table-wrap, #data-analytics-portable-reader .portable-table-scroll"
          )).filter((table) => {
            const rect = table.getBoundingClientRect();
            const style = getComputedStyle(table);
            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          }).length,
          colour_scheme_matches: window.matchMedia(`(prefers-color-scheme: ${
            window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
          })`).matches,
          prefers_dark: window.matchMedia("(prefers-color-scheme: dark)").matches
        };
      });
      dom.chart_text_integrity = chartTextIntegrity;
      if (portable && (dom.reader_state !== "ready" || dom.reader_visible !== true)) {
        throw new Error(`portable reader is not visibly ready: ${dom.reader_state}`);
      }
      if (dom.document_state !== "complete") throw new Error(`document state is ${dom.document_state}`);
      if (dom.visible_text_characters < 40) throw new Error("document has insufficient visible text");
      if (dom.scroll_width > dom.client_width + 1) {
        throw new Error(`horizontal overflow ${dom.scroll_width}px exceeds ${dom.client_width}px`);
      }
      if (dom.prefers_dark !== (scheme === "dark")) throw new Error(`browser did not apply ${scheme} colour scheme`);
      if (tableScrollChecks.length !== dom.table_count) throw new Error("table-scroll checks did not cover every table");
      for (const tableCheck of tableScrollChecks) {
        if (!tableCheck.visible) throw new Error(`table ${tableCheck.index} is not visible`);
        if (tableCheck.overflow && (!tableCheck.moved || !tableCheck.reached_right_edge || !tableCheck.returned_left_edge)) {
          throw new Error(`table ${tableCheck.index} horizontal scrolling did not reach both edges`);
        }
      }
      if (externalRequests.length) throw new Error(`external requests attempted: ${externalRequests.join(", ")}`);
      if (externalWebSockets.length) throw new Error(`WebSocket connections attempted: ${externalWebSockets.join(", ")}`);
      if (pageErrors.length) throw new Error(`page errors: ${pageErrors.join(" | ")}`);
      if (consoleErrors.length) throw new Error(`console errors: ${consoleErrors.join(" | ")}`);
      const screenshots = [];
      let tilePositions = [];
      if (viewport.coverage_mode === "full_tiling") {
        tilePositions = buildTilePositions(dom.scroll_height, viewport.height);
        for (let tileIndex = 0; tileIndex < tilePositions.length; tileIndex += 1) {
          const intendedScrollY = tilePositions[tileIndex];
          const actualScrollY = await page.evaluate(async (scrollY) => {
            window.scrollTo(0, scrollY);
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            return window.scrollY;
          }, intendedScrollY);
          const tileName = `${baseName}-tile-${String(tileIndex + 1).padStart(3, "0")}`;
          const tilePath = path.join(outDir, `${tileName}.png`);
          await page.screenshot({ path: tilePath, fullPage: false, animations: "disabled", timeout: 20_000 });
          screenshots.push(screenshotRecord(tilePath, tileName, viewport, scheme, "viewport_tile", {
            tile_index: tileIndex + 1,
            scroll_y: actualScrollY,
            coverage_start_y: actualScrollY,
            coverage_end_y: Math.min(dom.scroll_height, actualScrollY + viewport.height),
            document_height: dom.scroll_height
          }));
        }
      }
      for (const tableCheck of tableScrollChecks.filter((table) => table.overflow)) {
        const rightEdge = await captureTableRightEdge(
          page,
          tableCheck.index,
          dom.sticky_header_height ?? 0,
          viewport.height
        );
        if (!rightEdge.reached_right_edge || !rightEdge.table_visible_in_viewport) {
          throw new Error(`table ${tableCheck.index} right edge was not visibly captured`);
        }
        const rightEdgeName = `${baseName}-table-${String(tableCheck.index + 1).padStart(3, "0")}-right`;
        const rightEdgePath = path.join(outDir, `${rightEdgeName}.png`);
        await page.screenshot({ path: rightEdgePath, fullPage: false, animations: "disabled", timeout: 20_000 });
        const rightEdgeRecord = screenshotRecord(
          rightEdgePath,
          rightEdgeName,
          viewport,
          scheme,
          "viewport_table_right_edge",
          { ...rightEdge, document_height: dom.scroll_height }
        );
        screenshots.push(rightEdgeRecord);
        tableCheck.right_edge_capture = rightEdgeName;
        tableCheck.right_edge_capture_sha256 = rightEdgeRecord.sha256;
        await resetTableScroll(page, tableCheck.index);
      }
      const fullPageOriginScrollY = await resetDocumentScrollForFullPage(page);
      await page.screenshot({ path: fullPath, fullPage: true, animations: "disabled" });
      screenshots.push(screenshotRecord(fullPath, `${baseName}-full`, viewport, scheme, "full_page", {
        document_height: dom.scroll_height
      }));
      return {
        attempts: attempt,
        name: baseName,
        viewport,
        coverage_mode: viewport.coverage_mode,
        dom_status: "passed",
        interaction_status: "passed",
        colour_scheme: scheme,
        dom,
        render_convergence: renderConvergence,
        full_page_origin_scroll_y: fullPageOriginScrollY,
        table_scroll_checks: tableScrollChecks,
        tile_positions: tilePositions,
        external_requests: externalRequests,
        external_websockets: externalWebSockets,
        page_errors: pageErrors,
        console_errors: consoleErrors,
        screenshots
      };
    } catch (error) {
      failures.push(`attempt ${attempt}: ${error.message}`);
    } finally {
      await context.close();
    }
  }
  throw new Error(`Screenshot failed for ${viewport.name}/${scheme}: ${failures.join(" | ")}`);
}

export async function captureScreenshots({ html, outDir, receipt, runId, builderReceipt }) {
  const startedAt = new Date().toISOString();
  if (!fs.existsSync(html)) throw new Error(`HTML does not exist: ${html}`);
  if (!fs.existsSync(builderReceipt)) throw new Error(`Builder receipt does not exist: ${builderReceipt}`);
  const builderAttestation = JSON.parse(fs.readFileSync(builderReceipt, "utf8"));
  if (builderAttestation.version !== 3 || builderAttestation.run_id !== runId) {
    throw new Error("Builder receipt run_id does not match this capture run");
  }
  const htmlSource = fs.readFileSync(html, "utf8");
  assertSelfContainedStylesheets(htmlSource);
  const cssBreakpoints = discoverCssBreakpoints([htmlSource]);
  const responsiveViewportMatrix = buildResponsiveViewportMatrix({
    representativeViewports: REPRESENTATIVE_VIEWPORTS,
    breakpoints: cssBreakpoints,
    minimumWidth: DEFAULT_MINIMUM_VIEWPORT_WIDTH,
    maximumWidth: DEFAULT_MAXIMUM_VIEWPORT_WIDTH,
    boundaryDelta: 1,
    boundaryHeight: DEFAULT_BOUNDARY_HEIGHT
  });
  const playwrightRuntime = attestPlaywrightRuntime();
  const { chromium } = await import("playwright-core");
  const executable = resolveBrowser();
  fs.mkdirSync(outDir, { recursive: true });
  for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".png")) {
      fs.rmSync(path.join(outDir, entry.name), { force: true });
    }
  }
  fs.rmSync(receipt, { force: true });
  const htmlUrl = pathToFileURL(html).href;
  const screenshots = [];
  const browserChecks = [];
  const browser = await chromium.launch({
    executablePath: executable,
    headless: true,
    chromiumSandbox: true,
    args: [
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-domain-reliability",
      "--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication",
      "--disable-sync",
      "--force-color-profile=srgb",
      "--hide-scrollbars",
      "--metrics-recording-only",
      "--mute-audio"
    ]
  });
  const browserVersion = browser.version();
  const versionResult = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (versionResult.error || versionResult.status !== 0) {
    throw new Error(`Could not verify browser executable: ${versionResult.error?.message ?? versionResult.stderr}`);
  }
  const commandVersion = versionResult.stdout.trim();
  if (!commandVersion.includes(browserVersion)) throw new Error("Browser executable version does not match the launched browser");
  try {
    for (const scheme of ["light", "dark"]) {
      for (const viewport of responsiveViewportMatrix) {
        const captureResult = await capture(browser, htmlUrl, outDir, viewport, scheme);
        screenshots.push(...captureResult.screenshots);
        browserChecks.push({
          attempts: captureResult.attempts,
          name: captureResult.name,
          viewport: captureResult.viewport,
          coverage_mode: captureResult.coverage_mode,
          dom_status: captureResult.dom_status,
          interaction_status: captureResult.interaction_status,
          colour_scheme: captureResult.colour_scheme,
          dom: captureResult.dom,
          render_convergence: captureResult.render_convergence,
          full_page_origin_scroll_y: captureResult.full_page_origin_scroll_y,
          table_scroll_checks: captureResult.table_scroll_checks,
          tile_positions: captureResult.tile_positions,
          external_requests: captureResult.external_requests,
          external_websockets: captureResult.external_websockets,
          page_errors: captureResult.page_errors,
          console_errors: captureResult.console_errors
        });
      }
    }
  } finally {
    await browser.close();
  }
  for (const viewport of responsiveViewportMatrix) {
    const light = screenshots.filter((shot) => shot.viewport_width === viewport.width && shot.colour_scheme === "light");
    const dark = screenshots.filter((shot) => shot.viewport_width === viewport.width && shot.colour_scheme === "dark");
    if (light.length !== dark.length) throw new Error(`${viewport.name} light/dark capture counts differ`);
    for (const lightShot of light) {
      const pairedName = lightShot.name.replace(`${viewport.name}-light-`, `${viewport.name}-dark-`);
      const darkShot = dark.find((shot) => shot.name === pairedName);
      if (!darkShot || lightShot.sha256 === darkShot.sha256) {
        throw new Error(`${viewport.name} ${lightShot.capture_kind} did not produce distinct light and dark renders`);
      }
    }
  }
  const payload = {
    version: 5,
    ok: true,
    run_id: runId,
    started_at: startedAt,
    generated_at: new Date().toISOString(),
    capture_status: "passed",
    visual_review_status: "pending",
    html: { path: html, sha256: sha256(html) },
    builder_receipt: { path: builderReceipt, sha256: sha256(builderReceipt) },
    capture_script: { path: fileURLToPath(import.meta.url), sha256: sha256(fileURLToPath(import.meta.url)) },
    runtime: {
      node: {
        version: process.version,
        exec_path: process.execPath,
        platform: process.platform,
        architecture: process.arch
      },
      playwright_core: playwrightRuntime
    },
    browser: {
      executable,
      version: browserVersion,
      command_version: commandVersion,
      sha256: sha256(executable)
    },
    network_policy: createCaptureNetworkPolicy(htmlUrl).descriptor,
    responsive: {
      css_breakpoints: cssBreakpoints,
      minimum_width: DEFAULT_MINIMUM_VIEWPORT_WIDTH,
      maximum_width: DEFAULT_MAXIMUM_VIEWPORT_WIDTH,
      boundary_delta: 1,
      viewport_matrix: responsiveViewportMatrix
    },
    browser_checks: browserChecks,
    screenshots
  };
  fs.mkdirSync(path.dirname(receipt), { recursive: true });
  fs.writeFileSync(receipt, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

async function runCli(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(
        "Usage: capture-report-screenshots.mjs --html <report.html> --out-dir <qa-dir> --receipt <receipt.json> " +
        "--run-id <id> --builder-receipt <attestation.json>\n"
      );
      return;
    }
    process.stdout.write(`${JSON.stringify(await captureScreenshots(options))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await runCli();
