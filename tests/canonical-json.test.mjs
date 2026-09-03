import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson } from "../runner/canonical-json.mjs";

test("canonical JSON matches the value that survives JSON persistence", () => {
  const value = {
    z_omitted: undefined,
    nested: { omitted: undefined, kept: true },
    array_value: ["kept", undefined]
  };
  const persisted = JSON.parse(JSON.stringify(value));

  assert.equal(canonicalJson(value), '{"array_value":["kept",null],"nested":{"kept":true}}');
  assert.equal(canonicalJson(value), canonicalJson(persisted));
});
