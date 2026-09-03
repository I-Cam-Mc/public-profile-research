import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const TRUSTED_PLAYWRIGHT_CORE_TREE_SHA256 = "d2641372e20945af8d4f178121db81653a756d46fcf38b083f3f26465ad27d75";

export const PLAYWRIGHT_CORE_CRITICAL_PATHS = Object.freeze([
  "browsers.json",
  "index.js",
  "index.mjs",
  "lib/bootstrap.js",
  "lib/coreBundle.js",
  "lib/utilsBundle.js",
  "package.json"
]);

const EXPECTED_PACKAGE_NAME = "playwright-core";
const EXPECTED_PACKAGE_VERSION = "1.61.1";
const EXPECTED_LOCK_SHA256 = "97d09675d4ed182d7eb1022539aec11739eb016c84dffb5bcb51663d1da869a8";
const EXPECTED_RESOLVED = "https://registry.npmjs.org/playwright-core/-/playwright-core-1.61.1.tgz";
const EXPECTED_INTEGRITY = "sha512-h7Qlt6m4REp25qvIdvbDtVmD4LqVXfpRxhORv9L0jzETM05p4fuPJ3dKyuSXQxDSbXnmS79HAgi9589lGSpLkg==";

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function safeRegularFile(filePath, allowedRoot, label) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new Error(`${label} is missing: ${error.message}`);
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  const allowedRootReal = fs.realpathSync(allowedRoot);
  const fileReal = fs.realpathSync(filePath);
  if (!isWithin(allowedRootReal, fileReal)) throw new Error(`${label} resolves outside its allowed root`);
  return fileReal;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function exactEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} must be ${expected}; received ${String(actual)}`);
}

export function attestPlaywrightRuntime({ skillRoot = path.resolve(import.meta.dirname, "..") } = {}) {
  const resolvedSkillRoot = path.resolve(skillRoot);
  const skillRootStat = fs.lstatSync(resolvedSkillRoot);
  if (skillRootStat.isSymbolicLink()) throw new Error("Skill root must not be a symbolic link");
  if (!skillRootStat.isDirectory()) throw new Error("Skill root must be a directory");
  const skillRootReal = fs.realpathSync(resolvedSkillRoot);

  const runtimeRoot = path.join(resolvedSkillRoot, "node_modules", EXPECTED_PACKAGE_NAME);
  const runtimeRootStat = fs.lstatSync(runtimeRoot);
  if (runtimeRootStat.isSymbolicLink()) throw new Error("playwright-core root must not be a symbolic link");
  if (!runtimeRootStat.isDirectory()) throw new Error("playwright-core root must be a directory");
  const runtimeRootReal = fs.realpathSync(runtimeRoot);
  if (!isWithin(skillRootReal, runtimeRootReal)) throw new Error("playwright-core root resolves outside the skill root");

  const packagePath = path.join(runtimeRoot, "package.json");
  const packageReal = safeRegularFile(packagePath, runtimeRoot, "playwright-core/package.json");
  const packageDocument = readJson(packageReal, "playwright-core/package.json");
  exactEqual(packageDocument.name, EXPECTED_PACKAGE_NAME, "Playwright package name");
  exactEqual(packageDocument.version, EXPECTED_PACKAGE_VERSION, "Playwright package version");

  const criticalFiles = [...PLAYWRIGHT_CORE_CRITICAL_PATHS].sort().map((relativePath) => {
    const filePath = path.join(runtimeRoot, relativePath);
    const fileReal = safeRegularFile(filePath, runtimeRoot, `playwright-core/${relativePath}`);
    return { relative_path: relativePath, sha256: sha256File(fileReal) };
  });
  const canonicalBytes = criticalFiles
    .map(({ relative_path: relativePath, sha256 }) => `${relativePath}\0${sha256}\n`)
    .join("");
  const treeSha256 = sha256Bytes(canonicalBytes);
  exactEqual(treeSha256, TRUSTED_PLAYWRIGHT_CORE_TREE_SHA256, "Playwright runtime tree digest");

  const lockPath = path.join(resolvedSkillRoot, "package-lock.json");
  const lockReal = safeRegularFile(lockPath, resolvedSkillRoot, "package-lock.json");
  const lockSha256 = sha256File(lockReal);
  const lockDocument = readJson(lockPath, "package-lock.json");
  const dependencyPath = `node_modules/${EXPECTED_PACKAGE_NAME}`;
  const lockEntry = lockDocument?.packages?.[dependencyPath];
  if (!lockEntry || typeof lockEntry !== "object") throw new Error(`package-lock.json is missing ${dependencyPath}`);
  exactEqual(lockEntry.version, EXPECTED_PACKAGE_VERSION, "package-lock Playwright version");
  exactEqual(lockEntry.resolved, EXPECTED_RESOLVED, "package-lock Playwright resolved URL");
  exactEqual(lockEntry.integrity, EXPECTED_INTEGRITY, "package-lock Playwright integrity");
  exactEqual(lockSha256, EXPECTED_LOCK_SHA256, "Root package-lock digest");

  return {
    schema_version: 1,
    runtime: {
      package_name: packageDocument.name,
      package_version: packageDocument.version,
      critical_file_count: criticalFiles.length,
      canonical_algorithm: "sorted_relative_path_nul_file_sha256_lf",
      tree_sha256: treeSha256,
      critical_files: criticalFiles
    },
    package_lock: {
      relative_path: "package-lock.json",
      sha256: lockSha256,
      lockfile_version: lockDocument.lockfileVersion,
      dependency_path: dependencyPath,
      package_name: packageDocument.name,
      version: lockEntry.version,
      resolved: lockEntry.resolved,
      integrity: lockEntry.integrity
    }
  };
}

export function verifyPlaywrightRuntimeAttestation(receipt, options = {}) {
  if (!receipt || typeof receipt !== "object") throw new Error("Playwright runtime attestation is missing");
  exactEqual(receipt.schema_version, 1, "Playwright runtime attestation schema version");
  exactEqual(receipt?.runtime?.tree_sha256, TRUSTED_PLAYWRIGHT_CORE_TREE_SHA256, "Attested Playwright runtime tree digest");
  const observed = attestPlaywrightRuntime(options);
  if (JSON.stringify(receipt) !== JSON.stringify(observed)) {
    throw new Error("Playwright runtime attestation does not match the installed trusted runtime");
  }
  return true;
}
