import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  TRUSTED_PLAYWRIGHT_CORE_TREE_SHA256,
  attestPlaywrightRuntime,
  verifyPlaywrightRuntimeAttestation
} from "../scripts/playwright-runtime-attestation.mjs";

const skillRoot = path.resolve(import.meta.dirname, "..");

function makeFixture() {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "playwright-runtime-attestation-"));
  fs.copyFileSync(path.join(skillRoot, "package-lock.json"), path.join(fixtureRoot, "package-lock.json"));
  for (const relativePath of [
    "browsers.json",
    "index.js",
    "index.mjs",
    "lib/bootstrap.js",
    "lib/coreBundle.js",
    "lib/utilsBundle.js",
    "package.json"
  ]) {
    const target = path.join(fixtureRoot, "node_modules", "playwright-core", relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(skillRoot, "node_modules", "playwright-core", relativePath), target);
  }
  return fixtureRoot;
}

test("attests the pinned execution-critical Playwright runtime and lock identity", () => {
  const receipt = attestPlaywrightRuntime({ skillRoot });

  assert.equal(TRUSTED_PLAYWRIGHT_CORE_TREE_SHA256, "d2641372e20945af8d4f178121db81653a756d46fcf38b083f3f26465ad27d75");
  assert.deepEqual(receipt.runtime, {
    package_name: "playwright-core",
    package_version: "1.61.1",
    critical_file_count: 7,
    canonical_algorithm: "sorted_relative_path_nul_file_sha256_lf",
    tree_sha256: "d2641372e20945af8d4f178121db81653a756d46fcf38b083f3f26465ad27d75",
    critical_files: [
      { relative_path: "browsers.json", sha256: "ee39bc924bc3d1bd895626c2910f1292d109bbfeeb5abd113acb45e1951cc942" },
      { relative_path: "index.js", sha256: "a58fb2cec4293e7dcf73c58a179898a4f3986666451a19da4e731fa3af63265b" },
      { relative_path: "index.mjs", sha256: "3d36e2132d3c8b62397d23f0bb4177336aaee503203ae2a2c90fbeb5bf3317dd" },
      { relative_path: "lib/bootstrap.js", sha256: "97ffe165e8e45f1b51a713b3f380d383e4e183727135fe9a5e045ec62e9310ab" },
      { relative_path: "lib/coreBundle.js", sha256: "6be5c2ea035554e9b184b1dbc7aa5e7f1fb428dd1b5c202022858dcfae9bee27" },
      { relative_path: "lib/utilsBundle.js", sha256: "1295945f0054d2504c9b751945b15aa3c672530ad5a340f3f9636e5e238f304a" },
      { relative_path: "package.json", sha256: "759e376f995bf39edd4810d699b99469bab1d7428b6fbc78d41912f367df7ba9" }
    ]
  });
  assert.deepEqual(receipt.package_lock, {
    relative_path: "package-lock.json",
    sha256: "630c4c89bb8df7a33b3c1155b259997d99cc411e45661041bcd540cd5eee5879",
    lockfile_version: 3,
    dependency_path: "node_modules/playwright-core",
    package_name: "playwright-core",
    version: "1.61.1",
    resolved: "https://registry.npmjs.org/playwright-core/-/playwright-core-1.61.1.tgz",
    integrity: "sha512-h7Qlt6m4REp25qvIdvbDtVmD4LqVXfpRxhORv9L0jzETM05p4fuPJ3dKyuSXQxDSbXnmS79HAgi9589lGSpLkg=="
  });
  assert.equal(verifyPlaywrightRuntimeAttestation(receipt, { skillRoot }), true);
});

test("rejects an execution-critical Playwright file that was changed after installation", () => {
  const fixtureRoot = makeFixture();
  fs.appendFileSync(path.join(fixtureRoot, "node_modules", "playwright-core", "index.mjs"), "\n// changed\n");

  assert.throws(
    () => attestPlaywrightRuntime({ skillRoot: fixtureRoot }),
    /runtime tree digest/i
  );
});

test("rejects direct symbolic links in the attested Playwright file set", () => {
  const fixtureRoot = makeFixture();
  const target = path.join(fixtureRoot, "node_modules", "playwright-core", "index.mjs");
  const external = path.join(fixtureRoot, "external-index.mjs");
  fs.copyFileSync(target, external);
  fs.unlinkSync(target);
  fs.symlinkSync(external, target);

  assert.throws(
    () => attestPlaywrightRuntime({ skillRoot: fixtureRoot }),
    /index\.mjs must not be a symbolic link/i
  );
});

test("rejects a critical file whose parent link resolves outside the Playwright package", () => {
  const fixtureRoot = makeFixture();
  const runtimeRoot = path.join(fixtureRoot, "node_modules", "playwright-core");
  const externalLib = mkdtempSync(path.join(tmpdir(), "external-playwright-lib-"));
  for (const fileName of ["bootstrap.js", "coreBundle.js", "utilsBundle.js"]) {
    fs.copyFileSync(path.join(runtimeRoot, "lib", fileName), path.join(externalLib, fileName));
  }
  fs.rmSync(path.join(runtimeRoot, "lib"), { recursive: true });
  fs.symlinkSync(externalLib, path.join(runtimeRoot, "lib"), "dir");

  assert.throws(
    () => attestPlaywrightRuntime({ skillRoot: fixtureRoot }),
    /bootstrap\.js resolves outside its allowed root/i
  );
});

test("validates the installed package name and version as package metadata", () => {
  const fixtureRoot = makeFixture();
  const packagePath = path.join(fixtureRoot, "node_modules", "playwright-core", "package.json");
  const packageDocument = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  packageDocument.name = "lookalike-package";
  fs.writeFileSync(packagePath, `${JSON.stringify(packageDocument)}\n`);

  assert.throws(
    () => attestPlaywrightRuntime({ skillRoot: fixtureRoot }),
    /Playwright package name must be playwright-core/i
  );
});

test("rejects a mismatched installed Playwright version", () => {
  const fixtureRoot = makeFixture();
  const packagePath = path.join(fixtureRoot, "node_modules", "playwright-core", "package.json");
  const packageDocument = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  packageDocument.version = "1.61.2";
  fs.writeFileSync(packagePath, `${JSON.stringify(packageDocument)}\n`);

  assert.throws(
    () => attestPlaywrightRuntime({ skillRoot: fixtureRoot }),
    /Playwright package version must be 1\.61\.1/i
  );
});

test("validates the package-lock Playwright source and integrity fields", () => {
  const fixtureRoot = makeFixture();
  const lockPath = path.join(fixtureRoot, "package-lock.json");
  const lockDocument = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  lockDocument.packages["node_modules/playwright-core"].resolved = "https://example.test/lookalike.tgz";
  fs.writeFileSync(lockPath, `${JSON.stringify(lockDocument)}\n`);

  assert.throws(
    () => attestPlaywrightRuntime({ skillRoot: fixtureRoot }),
    /package-lock Playwright resolved URL must be https:\/\/registry\.npmjs\.org/i
  );
});

test("rejects a mismatched package-lock Playwright integrity", () => {
  const fixtureRoot = makeFixture();
  const lockPath = path.join(fixtureRoot, "package-lock.json");
  const lockDocument = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  lockDocument.packages["node_modules/playwright-core"].integrity = "sha512-lookalike";
  fs.writeFileSync(lockPath, `${JSON.stringify(lockDocument)}\n`);

  assert.throws(
    () => attestPlaywrightRuntime({ skillRoot: fixtureRoot }),
    /package-lock Playwright integrity must be sha512-h7Qlt6m4/i
  );
});

test("verifier rejects a receipt whose trusted runtime digest was replaced", () => {
  const receipt = attestPlaywrightRuntime({ skillRoot });
  receipt.runtime.tree_sha256 = "0".repeat(64);

  assert.throws(
    () => verifyPlaywrightRuntimeAttestation(receipt, { skillRoot }),
    /Attested Playwright runtime tree digest must be d2641372/i
  );
});
