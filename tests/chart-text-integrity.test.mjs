import assert from "node:assert/strict";
import test from "node:test";

import { assessChartTextIntegrity } from "../scripts/capture-report-screenshots.mjs";

test("chart text integrity rejects a portable chart without its stable fallback binding", () => {
  const result = assessChartTextIntegrity([{
    chart_id: "unbound",
    fallback_contract: {
      expected: true,
      identity_found: false,
      table_found: false,
      row_count: 0,
    },
    categories: [],
    ticks: [],
  }]);

  assert.equal(result.status, "failed");
  assert.equal(result.fallback_binding_failure_count, 1);
  assert.match(result.issues[0].reason, /category evidence|fallback data/i);
});

test("chart text integrity permits a portable empty chart with a bound empty fallback table", () => {
  const result = assessChartTextIntegrity([{
    chart_id: "empty",
    fallback_contract: {
      expected: true,
      identity_found: true,
      table_found: true,
      row_count: 0,
    },
    categories: [],
    ticks: [],
  }]);

  assert.equal(result.status, "passed");
  assert.equal(result.fallback_binding_failure_count, 0);
});

test("chart text integrity does not impose the portable fallback contract on a non-portable chart", () => {
  const result = assessChartTextIntegrity([{
    chart_id: "external",
    fallback_contract: {
      expected: false,
      identity_found: false,
      table_found: false,
      row_count: 0,
    },
    categories: [],
    ticks: [],
  }]);

  assert.equal(result.status, "passed");
  assert.equal(result.fallback_binding_failure_count, 0);
});

test("chart text integrity rejects labels shortened with an ellipsis", () => {
  const result = assessChartTextIntegrity([{
    chart_id: "coverage",
    categories: ["Long-form video"],
    ticks: [{ lines: ["Long…", "vid…"], title: "Long-form video" }],
  }]);

  assert.equal(result.status, "failed");
  assert.equal(result.truncated_label_count, 1);
  assert.match(result.issues[0].reason, /truncated/i);
});

test("chart text integrity rejects a category split inside a word", () => {
  const result = assessChartTextIntegrity([{
    chart_id: "coverage",
    categories: ["Twitch"],
    ticks: [{ lines: ["Twi", "tch"], title: "" }],
  }]);

  assert.equal(result.status, "failed");
  assert.equal(result.mid_word_wrap_count, 1);
  assert.match(result.issues[0].reason, /inside a word/i);
});

test("chart text integrity permits wrapping at an original word boundary", () => {
  const result = assessChartTextIntegrity([{
    chart_id: "coverage",
    categories: ["Long form video"],
    ticks: [{ lines: ["Long form", "video"], title: "" }],
  }]);

  assert.equal(result.status, "passed");
  assert.equal(result.matched_category_tick_count, 1);
  assert.deepEqual(result.issues, []);
});

test("chart text integrity permits complete horizontal category labels and ignores numeric ticks", () => {
  const result = assessChartTextIntegrity([{
    chart_id: "coverage",
    categories: ["Long-form video", "Partner series"],
    ticks: [
      { lines: ["Long-form video"], title: "" },
      { lines: ["Partner series"], title: "" },
      { lines: ["800"], title: "" },
    ],
  }]);

  assert.equal(result.status, "passed");
  assert.equal(result.matched_category_tick_count, 2);
  assert.deepEqual(result.issues, []);
});

test("chart text integrity rejects omitted labels in a small categorical chart", () => {
  const result = assessChartTextIntegrity([{
    chart_id: "coverage",
    categories: ["Livestreams", "Social posts", "Long-form video", "Partner series", "Code portfolio", "Written archive"],
    ticks: [
      { lines: ["Livestreams"], title: "" },
      { lines: ["Long-form video"], title: "" },
      { lines: ["Code portfolio"], title: "" },
      { lines: ["Written archive"], title: "" },
    ],
  }]);

  assert.equal(result.status, "failed");
  assert.equal(result.omitted_category_count, 2);
  assert.deepEqual(result.omitted_categories, ["Social posts", "Partner series"]);
  assert.match(result.issues.at(-1).reason, /omitted/i);
});

test("chart text integrity rejects overlapping categorical tick rectangles", () => {
  const result = assessChartTextIntegrity([{
    chart_id: "coverage",
    categories: ["Alpha", "Beta"],
    ticks: [
      { lines: ["Alpha"], title: "", rect: { left: 10, right: 50, top: 100, bottom: 120 } },
      { lines: ["Beta"], title: "", rect: { left: 45, right: 80, top: 105, bottom: 125 } },
    ],
  }]);

  assert.equal(result.status, "failed");
  assert.equal(result.overlapping_label_count, 1);
  assert.match(result.issues.at(-1).reason, /overlap/i);
});

test("chart text integrity rejects a label clipped by an actual overflow ancestor", () => {
  const result = assessChartTextIntegrity([{
    chart_id: "coverage",
    categories: ["Alpha"],
    ticks: [{
      lines: ["Alpha"],
      title: "",
      rect: { left: 8, right: 52, top: 100, bottom: 120 },
      clipping_rects: [{ left: 10, right: 100, top: 90, bottom: 140 }],
    }],
  }]);

  assert.equal(result.status, "failed");
  assert.equal(result.clipped_label_count, 1);
  assert.match(result.issues.at(-1).reason, /clip/i);
});
