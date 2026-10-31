"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeUuid, isValidUuid, parseReading } = require("./ble-protocol.js");

function dataView(bytes) {
  return new DataView(Uint8Array.from(bytes).buffer);
}

function text(value) {
  const bytes = new TextEncoder().encode(value);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

test("normalizes Bluetooth SIG short UUIDs and aliases", () => {
  assert.equal(normalizeUuid("0x181A"), "0000181a-0000-1000-8000-00805f9b34fb");
  assert.equal(normalizeUuid("temperature"), "00002a6e-0000-1000-8000-00805f9b34fb");
  assert.equal(isValidUuid("2a6f"), true);
  assert.equal(isValidUuid("not-a-uuid"), false);
});

test("decodes signed SIG temperature and unsigned humidity in little-endian hundredths", () => {
  assert.equal(parseReading({ format: "sig-temperature" }, dataView([0x21, 0x09])), 23.37);
  assert.equal(parseReading({ format: "sig-temperature" }, dataView([0x8e, 0xff])), -1.14);
  assert.equal(parseReading({ format: "sig-humidity" }, dataView([0x11, 0x17])), 59.05);
  assert.throws(() => parseReading({ format: "sig-temperature" }, dataView([0])), /exactly 2 bytes/);
});

test("parses numeric UTF-8, nested JSON, and selected CSV columns", () => {
  assert.equal(parseReading({ format: "numeric-text" }, text(" 28.45 ")), 28.45);
  assert.equal(parseReading({ format: "json", jsonPath: "sensors.temperature.value" },
    text('{"sensors":{"temperature":{"value":26.5}}}')), 26.5);
  assert.equal(parseReading({ format: "csv", csvColumn: 1 }, text("temperature,21.25,humidity")), 21.25);
  assert.throws(() => parseReading({ format: "json", jsonPath: "missing.value" }, text("{}")), /not found/);
});

test("decodes configured binary types and byte order", () => {
  assert.equal(parseReading({ format: "binary-uint16", scale: 0.1 }, dataView([0xfa, 0x00])), 25);
  assert.equal(parseReading({ format: "binary-int16", endianness: "big" }, dataView([0xff, 0xfe])), -2);
  assert.equal(parseReading({ format: "binary-float32" }, dataView([0, 0, 0x20, 0x41])), 10);
  assert.throws(() => parseReading({ format: "binary-int32" }, dataView([0, 1])), /exact binary width/);
});

test("applies scale, offset, and configured measurement bounds", () => {
  assert.equal(parseReading({ format: "numeric-text", scale: 2, offset: -1 }, text("4")), 7);
  assert.throws(() => parseReading({ format: "numeric-text", minValue: 5 }, text("4")), /below the configured minimum/);
  assert.throws(() => parseReading({ format: "numeric-text", scale: "NaN" }, text("4")), /finite numbers/);
  assert.throws(() => parseReading({ format: "numeric-text", minValue: "NaN" }, text("4")), /bounds are invalid/);
  assert.throws(() => parseReading({ format: 1 }, text("4")), /format must be a string/);
});
