import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertMeaningfulScreenshot,
  buildTilePositions,
  isAllowedReportRequest,
  inspectPng
} from "../scripts/capture-report-screenshots.mjs";

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, payload) {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + payload.length);
  output.writeUInt32BE(payload.length, 0);
  typeBytes.copy(output, 4);
  payload.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, payload])), 8 + payload.length);
  return output;
}

function writeRgbPng(filePath, width, height, pixel) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = pixel(x, y);
      const offset = 1 + x * 3;
      row[offset] = red;
      row[offset + 1] = green;
      row[offset + 2] = blue;
    }
    rows.push(row);
  }
  fs.writeFileSync(filePath, Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0))
  ]));
}

test("a uniform screenshot is rejected even when it is a valid PNG", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "blank-report-png-"));
  const filePath = path.join(directory, "blank.png");
  writeRgbPng(filePath, 390, 844, () => [24, 24, 24]);
  const metrics = inspectPng(filePath);
  assert.equal(metrics.width, 390);
  assert.equal(metrics.height, 844);
  assert.equal(metrics.unique_colours, 1);
  assert.throws(
    () => assertMeaningfulScreenshot(metrics, { width: 390, height: 844 }),
    /blank or visually empty/i
  );
});

test("a content-bearing screenshot passes and records visual metrics", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "content-report-png-"));
  const filePath = path.join(directory, "content.png");
  writeRgbPng(filePath, 390, 844, (x, y) => {
    if (x > 20 && x < 370 && y > 50 && y < 150) return [200, 40 + (x % 80), 40];
    if ((x + y) % 71 === 0) return [230, 230, 230];
    return [24, 24, 24];
  });
  const metrics = inspectPng(filePath);
  assert.ok(metrics.unique_colours > 4);
  assert.ok(metrics.non_dominant_ratio > 0.001);
  assert.doesNotThrow(() => assertMeaningfulScreenshot(metrics, { width: 390, height: 844 }));
});

test("the pixel gate rejects a screenshot with the wrong viewport dimensions", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "wrong-report-png-"));
  const filePath = path.join(directory, "wrong.png");
  writeRgbPng(filePath, 100, 100, (x, y) => [x % 255, y % 255, (x + y) % 255]);
  const metrics = inspectPng(filePath);
  assert.throws(
    () => assertMeaningfulScreenshot(metrics, { width: 390, height: 844 }),
    /dimensions/i
  );
});

test("request routing permits only the exact report file plus embedded data", () => {
  const reportUrl = "file:///private/tmp/report/report.html";
  assert.equal(isAllowedReportRequest(reportUrl, reportUrl), true);
  assert.equal(isAllowedReportRequest("data:text/plain,embedded", reportUrl), true);
  assert.equal(isAllowedReportRequest("blob:null/123", reportUrl), true);
  assert.equal(isAllowedReportRequest("file:///private/tmp/report/secret.txt", reportUrl), false);
  assert.equal(isAllowedReportRequest("https://example.test/tracker.js", reportUrl), false);
});

test("viewport tiling covers the whole document without unreadable gaps", () => {
  const positions = buildTilePositions(19_397, 844);
  assert.equal(positions[0], 0);
  assert.equal(positions.at(-1), 19_397 - 844);
  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(positions[index] > positions[index - 1]);
    assert.ok(positions[index] <= positions[index - 1] + 844);
  }
});
