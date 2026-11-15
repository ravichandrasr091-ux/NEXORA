"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeUuid,
  isValidUuid,
  isProfileCompatible,
  parseReading,
  parseControllerStatus,
  parseControllerAcknowledgement,
  encodeTargetCommand
} = require("./ble-protocol.js");

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

test("selects only sensor profiles whose required characteristics were discovered with usable access", () => {
  const profile = {
    serviceUuid: "0000181a-0000-1000-8000-00805f9b34fb",
    sensors: [
      { characteristicUuid: "00002a6e-0000-1000-8000-00805f9b34fb", mode: "read" },
      { characteristicUuid: "00002a6f-0000-1000-8000-00805f9b34fb", mode: "read" }
    ]
  };
  const characteristics = [
    { serviceUuid: profile.serviceUuid, uuid: profile.sensors[0].characteristicUuid, properties: ["read"] },
    { serviceUuid: profile.serviceUuid, uuid: profile.sensors[1].characteristicUuid, properties: ["read", "notify"] }
  ];
  assert.equal(isProfileCompatible(profile, characteristics), true);
  assert.equal(isProfileCompatible(profile, characteristics.slice(0, 1)), false);
  assert.equal(isProfileCompatible(profile, [
    ...characteristics.slice(0, 1),
    { ...characteristics[1], properties: ["write"] }
  ]), false);
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
});

test("parses controller status and acknowledgement without treating rejected targets as confirmed", () => {
  assert.deepEqual(parseControllerStatus(text("NEXORA/1|STATUS|HEATER_UNAVAILABLE|SENSOR_OK|120|3")), {
    heaterState: "HEATER_UNAVAILABLE",
    sensorState: "SENSOR_OK",
    uptimeSeconds: 120,
    bootCount: 3
  });
  assert.deepEqual(parseControllerAcknowledgement(text("NEXORA/1|ACK|7|REJECTED|HEATER_OUTPUT_UNVERIFIED")), {
    sequence: 7,
    result: "REJECTED",
    reason: "HEATER_OUTPUT_UNVERIFIED"
  });
  assert.throws(() => parseControllerStatus(text("NEXORA/1|STATUS|HEATER_ON|SENSOR_OK|1|1")), /Invalid Smart Chamber controller status/);
  assert.throws(() => parseControllerAcknowledgement(text("NEXORA/1|ACK|x|ACCEPTED|OK")), /Invalid Smart Chamber command acknowledgement/);
});

test("encodes only valid half-degree setpoint requests", () => {
  assert.equal(encodeTargetCommand(65535, 40.5), "NEXORA/1|SET_TARGET|65535|405");
  assert.throws(() => encodeTargetCommand(0, 40), /sequence/);
  assert.throws(() => encodeTargetCommand(1, 40.2), /0.5°C increments/);
  assert.throws(() => encodeTargetCommand(1, 100.5), /1°C and 100°C/);
  assert.throws(() => parseReading({ format: 1 }, text("4")), /format must be a string/);
});
