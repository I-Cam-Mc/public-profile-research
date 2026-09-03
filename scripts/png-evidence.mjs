import fs from "node:fs";
import { inflateSync } from "node:zlib";

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

export function inspectPng(filePath) {
  const bytes = fs.readFileSync(filePath);
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error(`Screenshot is not a PNG: ${filePath}`);
  }
  let offset = 8;
  let header;
  const imageData = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + length;
    if (payloadEnd + 4 > bytes.length) throw new Error(`Malformed PNG chunk in ${filePath}`);
    const payload = bytes.subarray(payloadStart, payloadEnd);
    if (type === "IHDR") {
      header = {
        width: payload.readUInt32BE(0),
        height: payload.readUInt32BE(4),
        bitDepth: payload[8],
        colourType: payload[9],
        interlace: payload[12]
      };
    } else if (type === "IDAT") {
      imageData.push(payload);
    } else if (type === "IEND") {
      break;
    }
    offset = payloadEnd + 4;
  }
  if (!header || !imageData.length) throw new Error(`PNG image data is incomplete: ${filePath}`);
  if (header.bitDepth !== 8 || header.interlace !== 0) {
    throw new Error(`Unsupported PNG encoding for visual QA: ${header.bitDepth}-bit interlace=${header.interlace}`);
  }
  const channelsByType = new Map([[0, 1], [2, 3], [4, 2], [6, 4]]);
  const channels = channelsByType.get(header.colourType);
  if (!channels) throw new Error(`Unsupported PNG colour type for visual QA: ${header.colourType}`);
  const stride = header.width * channels;
  const inflated = inflateSync(Buffer.concat(imageData));
  const expectedLength = (stride + 1) * header.height;
  if (inflated.length !== expectedLength) {
    throw new Error(`Unexpected PNG data length: expected ${expectedLength}, found ${inflated.length}`);
  }
  const pixels = Buffer.alloc(stride * header.height);
  for (let y = 0; y < header.height; y += 1) {
    const sourceOffset = y * (stride + 1);
    const filter = inflated[sourceOffset];
    const rowOffset = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[sourceOffset + 1 + x];
      const left = x >= channels ? pixels[rowOffset + x - channels] : 0;
      const above = y > 0 ? pixels[rowOffset - stride + x] : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[rowOffset - stride + x - channels] : 0;
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + above;
      else if (filter === 3) value = raw + Math.floor((left + above) / 2);
      else if (filter === 4) value = raw + paeth(left, above, upperLeft);
      else throw new Error(`Unsupported PNG row filter: ${filter}`);
      pixels[rowOffset + x] = value & 0xff;
    }
  }

  const colourCounts = new Map();
  let luminanceSum = 0;
  let luminanceSquaredSum = 0;
  let dominantCount = 0;
  let minimumAlpha = 255;
  const pixelCount = header.width * header.height;
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const channelOffset = pixelIndex * channels;
    const red = pixels[channelOffset];
    const green = header.colourType === 0 || header.colourType === 4 ? red : pixels[channelOffset + 1];
    const blue = header.colourType === 0 || header.colourType === 4 ? red : pixels[channelOffset + 2];
    const alpha = header.colourType === 4
      ? pixels[channelOffset + 1]
      : header.colourType === 6
        ? pixels[channelOffset + 3]
        : 255;
    minimumAlpha = Math.min(minimumAlpha, alpha);
    const colour = (red << 16) | (green << 8) | blue;
    const count = (colourCounts.get(colour) ?? 0) + 1;
    colourCounts.set(colour, count);
    if (count > dominantCount) dominantCount = count;
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    luminanceSum += luminance;
    luminanceSquaredSum += luminance * luminance;
  }
  const mean = luminanceSum / pixelCount;
  const variance = Math.max(0, luminanceSquaredSum / pixelCount - mean * mean);
  return {
    width: header.width,
    height: header.height,
    unique_colours: colourCounts.size,
    dominant_colour_ratio: dominantCount / pixelCount,
    non_dominant_ratio: 1 - dominantCount / pixelCount,
    luminance_stddev: Math.sqrt(variance),
    minimum_alpha: minimumAlpha,
    has_transparency: minimumAlpha < 255
  };
}

export function assertMeaningfulScreenshot(metrics, expectedViewport) {
  if (metrics.width !== expectedViewport.width || metrics.height !== expectedViewport.height) {
    throw new Error(
      `Screenshot dimensions ${metrics.width}x${metrics.height} do not match ` +
      `${expectedViewport.width}x${expectedViewport.height}`
    );
  }
  if (metrics.has_transparency) {
    throw new Error(`Screenshot contains transparent pixels (minimum alpha ${metrics.minimum_alpha})`);
  }
  if (metrics.unique_colours < 4 || metrics.non_dominant_ratio < 0.001 || metrics.luminance_stddev < 1) {
    throw new Error(
      `Screenshot is blank or visually empty: colours=${metrics.unique_colours}, ` +
      `non-dominant=${metrics.non_dominant_ratio.toFixed(6)}, ` +
      `luminance-stddev=${metrics.luminance_stddev.toFixed(3)}`
    );
  }
}
