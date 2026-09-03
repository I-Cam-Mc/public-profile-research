#!/usr/bin/env node

import { access, readdir, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";

const REQUIRED_SCHEMAS = [
  "schemas/intake.schema.json",
  "schemas/report.schema.json",
  "schemas/job-plan.schema.json"
];
const RAW_SCHEMA_BASE = "https://raw.githubusercontent.com/I-Cam-Mc/public-profile-research/main/";
const RELEASE_DOC_NAMES = new Set([
  "ACKNOWLEDGEMENTS.md",
  "PORTABLE_PROMPT.md",
  "PRIVACY.md",
  "PROJECT_INSTRUCTIONS.md",
  "README.md",
  "SECURITY.md",
  "SKILL.md",
  "THIRD_PARTY_NOTICES.md"
]);
const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", ".playwright-cli", "public-profile-runs"]);
const EM_DASH_EXTENSIONS = new Set([".md", ".html", ".js", ".mjs"]);

function toRootPath(root) {
  if (root instanceof URL) return fileURLToPath(root);
  return resolve(root);
}

function displayPath(root, absolutePath) {
  return relative(root, absolutePath).replaceAll("\\", "/");
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function walk(root, directory = root, files = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) await walk(root, absolutePath, files);
      continue;
    }
    if (entry.isFile()) files.push(absolutePath);
  }
  return files;
}

function isReleaseMarkdown(root, absolutePath) {
  const relativePath = displayPath(root, absolutePath);
  return (
    RELEASE_DOC_NAMES.has(basename(absolutePath)) ||
    relativePath.startsWith("docs/") ||
    relativePath.startsWith("references/") ||
    relativePath.startsWith("prompts/")
  );
}

function parseFrontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  const fields = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (field) fields.set(field[1], field[2].replace(/^['"]|['"]$/g, ""));
  }
  return fields;
}

function isExternalReference(target) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target);
}

function cleanLinkTarget(rawTarget) {
  let target = rawTarget.trim();
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1).trim();
  const titleBoundary = target.search(/\s+["']/);
  if (titleBoundary >= 0) target = target.slice(0, titleBoundary);
  const hashIndex = target.search(/[?#]/);
  return hashIndex >= 0 ? target.slice(0, hashIndex) : target;
}

function markdownTargets(source) {
  const targets = [];
  const inline = /!?\[[^\]]*\]\(([^)]+)\)/g;
  const definitions = /^\s*\[[^\]]+\]:\s*(\S+)/gm;
  for (const match of source.matchAll(inline)) targets.push(match[1]);
  for (const match of source.matchAll(definitions)) targets.push(match[1]);
  return targets;
}

function localLinkPath(root, documentPath, target) {
  const decoded = decodeURIComponent(target);
  const candidate = isAbsolute(decoded) ? resolve(root, `.${decoded}`) : resolve(dirname(documentPath), decoded);
  const normalised = normalize(candidate);
  const rootRelative = relative(root, normalised);
  if (rootRelative === "" || (!rootRelative.startsWith("..") && !isAbsolute(rootRelative))) return normalised;
  return null;
}

async function validateMarkdownLinks(root, markdownFiles, errors) {
  for (const file of markdownFiles) {
    const source = await readFile(file, "utf8");
    const documentLabel = displayPath(root, file);
    for (const rawTarget of markdownTargets(source)) {
      const target = cleanLinkTarget(rawTarget);
      if (!target || target.startsWith("#") || isExternalReference(target)) continue;
      let localPath;
      try {
        localPath = localLinkPath(root, file, target);
      } catch {
        errors.push(`${documentLabel}: local Markdown link "${target}" is not a valid local path.`);
        continue;
      }
      if (!localPath || !(await exists(localPath))) {
        errors.push(`${documentLabel}: local Markdown link "${target}" does not resolve within the repository.`);
      }
    }
  }
}

async function validateSkill(root, errors) {
  const skillPath = join(root, "SKILL.md");
  if (!(await exists(skillPath))) {
    errors.push("SKILL.md: required release skill is missing.");
    return;
  }
  const fields = parseFrontmatter(await readFile(skillPath, "utf8"));
  if (!fields) {
    errors.push("SKILL.md: YAML frontmatter must start and end with ---.");
    errors.push('SKILL.md: YAML frontmatter must include a non-empty "name".');
    errors.push('SKILL.md: YAML frontmatter must include a non-empty "description".');
    return;
  }
  for (const field of ["name", "description"]) {
    if (!fields.get(field)?.trim()) errors.push(`SKILL.md: YAML frontmatter must include a non-empty "${field}".`);
  }
}

async function validateSchemas(root, errors) {
  for (const relativePath of REQUIRED_SCHEMAS) {
    const path = join(root, relativePath);
    if (!(await exists(path))) {
      errors.push(`${relativePath}: required release schema is missing.`);
      continue;
    }
    let schema;
    try {
      schema = JSON.parse(await readFile(path, "utf8"));
    } catch {
      errors.push(`${relativePath}: invalid JSON.`);
      continue;
    }
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      errors.push(`${relativePath}: schema must be a JSON object.`);
      continue;
    }
    const expectedId = `${RAW_SCHEMA_BASE}${relativePath}`;
    if (schema.$id !== expectedId) {
      errors.push(`${relativePath}: "$id" must be the public raw GitHub URL ${expectedId}.`);
    }
  }
}

async function validatePackage(root, errors) {
  const packagePath = join(root, "package.json");
  if (!(await exists(packagePath))) {
    errors.push("package.json: required release manifest is missing.");
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(packagePath, "utf8"));
  } catch {
    errors.push("package.json: invalid JSON.");
    return;
  }
  if (manifest.private !== true) errors.push('package.json: "private" must be true.');
  if (manifest.license !== "MIT") errors.push('package.json: "license" must be "MIT".');
}

async function validateEmDashes(root, files, errors) {
  for (const file of files) {
    const relativePath = displayPath(root, file);
    const inUserFacingDirectory =
      isReleaseMarkdown(root, file) ||
      relativePath.startsWith("website/") ||
      relativePath.startsWith("bin/") ||
      relativePath.startsWith("runner/") ||
      relativePath.startsWith("report/") ||
      relativePath.startsWith("server/");
    if (!inUserFacingDirectory || !EM_DASH_EXTENSIONS.has(extname(file))) continue;
    const source = await readFile(file, "utf8");
    const line = source.slice(0, source.indexOf("—")).split(/\r?\n/).length;
    if (source.includes("—")) errors.push(`${relativePath}:${line}: replace the em dash with punctuation compatible with project style.`);
  }
}

export async function validateRelease(root = fileURLToPath(new URL("..", import.meta.url))) {
  const rootPath = toRootPath(root);
  const errors = [];
  const files = await walk(rootPath);
  const markdownFiles = files.filter((file) => extname(file) === ".md" && isReleaseMarkdown(rootPath, file));

  await validateSkill(rootPath, errors);
  await validateMarkdownLinks(rootPath, markdownFiles, errors);
  await validateSchemas(rootPath, errors);
  await validatePackage(rootPath, errors);
  await validateEmDashes(rootPath, files, errors);

  return { errors, checked_files: files.length };
}

async function main() {
  const argumentIndex = process.argv.indexOf("--root");
  const root = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : fileURLToPath(new URL("..", import.meta.url));
  if (argumentIndex >= 0 && !root) {
    console.error("Release validation failed:\n- --root requires a repository directory.");
    process.exitCode = 64;
    return;
  }
  const result = await validateRelease(root);
  if (result.errors.length) {
    console.error(`Release validation failed:\n${result.errors.map((error) => `- ${error}`).join("\n")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Release validation passed (${result.checked_files} files checked).`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`Release validation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
