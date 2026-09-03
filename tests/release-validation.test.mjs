import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateRelease } from "../scripts/check-release.mjs";

const REPOSITORY_ROOT = new URL("..", import.meta.url);

test("release validation accepts the checked-in release surface", async () => {
  const result = await validateRelease(new URL(REPOSITORY_ROOT));

  assert.deepEqual(result.errors, []);
  assert.ok(result.checked_files > 0);
});

test("release validation reports independently actionable release faults", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppr-release-validation-"));
  await mkdir(join(root, "schemas"));
  await writeFile(join(root, "SKILL.md"), "# Missing frontmatter\n", "utf8");
  await writeFile(join(root, "README.md"), "[missing](does-not-exist.md)\n", "utf8");
  await writeFile(join(root, "package.json"), JSON.stringify({ private: false, license: "Apache-2.0" }), "utf8");
  await writeFile(join(root, "schemas", "intake.schema.json"), "{broken", "utf8");

  const result = await validateRelease(root);
  const output = result.errors.join("\n");

  assert.match(output, /SKILL\.md: YAML frontmatter must include a non-empty "name"/);
  assert.match(output, /README\.md: local Markdown link "does-not-exist\.md" does not resolve/);
  assert.match(output, /package\.json: "private" must be true/);
  assert.match(output, /package\.json: "license" must be "MIT"/);
  assert.match(output, /schemas\/intake\.schema\.json: invalid JSON/);
  assert.match(output, /schemas\/report\.schema\.json: required release schema is missing/);
  assert.match(output, /schemas\/job-plan\.schema\.json: required release schema is missing/);
});
