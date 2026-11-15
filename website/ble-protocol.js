(() => {
  "use strict";

  const UUID_BASE = "-0000-1000-8000-00805f9b34fb";
  const UUID_ALIASES = {
    environmental_sensing: "0000181a",
    temperature: "00002a6e",
    humidity: "00002a6f",
    pressure: "00002a6d"
  };
  const CONTROL_STATUS_PREFIX = "NEXORA/1|STATUS|";
  const CONTROL_ACK_PREFIX = "NEXORA/1|ACK|";
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const textDecoder = new TextDecoder("utf-8", { fatal: true });

  function normalizeUuid(value) {
    const raw = String(value ?? "").trim().toLowerCase();
    if (UUID_ALIASES[raw]) return `${UUID_ALIASES[raw]}${UUID_BASE}`;
    const short = raw.match(/^(?:0x)?([0-9a-f]{4})$/);
    if (short) return `0000${short[1]}${UUID_BASE}`;
    return raw;
  }

  function isValidUuid(value) {
    return UUID_PATTERN.test(normalizeUuid(value));
  }

  function isProfileCompatible(profile, characteristics) {
    if (!profile || !Array.isArray(profile.sensors) || !Array.isArray(characteristics)) return false;
    return profile.sensors.every(sensor => {
      const discovered = characteristics.find(item =>
        item.serviceUuid === profile.serviceUuid && item.uuid === sensor.characteristicUuid);
      if (!discovered || !Array.isArray(discovered.properties)) return false;
      return sensor.mode === "read"
        ? discovered.properties.includes("read")
        : discovered.properties.includes("notify") || discovered.properties.includes("indicate");
    });
  }

  function bytesToText(dataView) {
    return textDecoder.decode(new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength)).trim();
  }

  function readJsonPath(value, path) {
    if (!path) {
      if (typeof value === "number") return value;
      if (value && typeof value === "object" && typeof value.value === "number") return value.value;
      throw new Error("JSON payload needs a numeric value or a configured JSON field path.");
    }
    return path.split(".").reduce((current, part) => {
      if (current === null || typeof current !== "object" || !(part in current)) {
        throw new Error(`JSON field "${path}" was not found.`);
      }
      return current[part];
    }, value);
  }

  function parseRaw(sensor, dataView) {
    if (!(dataView instanceof DataView) || dataView.byteLength === 0) {
      throw new Error("Empty sensor payload.");
    }
    const format = sensor.format || "numeric-text";
    if (typeof format !== "string") throw new Error("Telemetry format must be a string.");
    if (format === "sig-temperature" || format === "sig-humidity") {
      if (dataView.byteLength !== 2) throw new Error("Bluetooth SIG environmental values must be exactly 2 bytes.");
      const raw = format === "sig-temperature"
        ? dataView.getInt16(0, true)
        : dataView.getUint16(0, true);
      return raw / 100;
    }
    if (format.startsWith("binary-")) {
      const littleEndian = sensor.endianness !== "big";
      switch (format) {
        case "binary-int16": if (dataView.byteLength === 2) return dataView.getInt16(0, littleEndian); break;
        case "binary-uint16": if (dataView.byteLength === 2) return dataView.getUint16(0, littleEndian); break;
        case "binary-int32": if (dataView.byteLength === 4) return dataView.getInt32(0, littleEndian); break;
        case "binary-uint32": if (dataView.byteLength === 4) return dataView.getUint32(0, littleEndian); break;
        case "binary-float32": if (dataView.byteLength === 4) return dataView.getFloat32(0, littleEndian); break;
        case "binary-float64": if (dataView.byteLength === 8) return dataView.getFloat64(0, littleEndian); break;
        default: throw new Error(`Unsupported binary format "${format}".`);
      }
      throw new Error(`${format} payload must contain its exact binary width.`);
    }

    const text = bytesToText(dataView);
    let value;
    if (format === "numeric-text") {
      if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) {
        throw new Error("Expected a UTF-8 numeric reading.");
      }
      value = Number(text);
    } else if (format === "json") {
      value = readJsonPath(JSON.parse(text), sensor.jsonPath || "");
    } else if (format === "csv") {
      const delimiter = sensor.csvDelimiter || ",";
      if (delimiter.length !== 1) throw new Error("CSV delimiter must be one character.");
      const column = Number.isInteger(sensor.csvColumn) ? sensor.csvColumn : 0;
      const cell = text.split(delimiter)[column]?.trim();
      if (cell === undefined || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(cell)) {
        throw new Error(`CSV column ${column + 1} is missing or is not numeric.`);
      }
      value = Number(cell);
    } else {
      throw new Error(`Unsupported telemetry format "${format}".`);
    }
    return value;
  }

  function parseReading(sensor, dataView) {
    if (!sensor || typeof sensor !== "object") throw new Error("Sensor profile is missing.");
    const scale = Number(sensor.scale ?? 1);
    const offset = Number(sensor.offset ?? 0);
    if (!Number.isFinite(scale) || !Number.isFinite(offset)) {
      throw new Error("Sensor scale and offset must be finite numbers.");
    }
    const raw = parseRaw(sensor, dataView);
    if (!Number.isFinite(raw)) throw new Error("Sensor payload is not a finite number.");
    const value = raw * scale + offset;
    if (!Number.isFinite(value)) throw new Error("Scaled sensor value is outside the numeric range.");
    const minValue = sensor.minValue === "" || sensor.minValue === null || sensor.minValue === undefined
      ? null : Number(sensor.minValue);
    const maxValue = sensor.maxValue === "" || sensor.maxValue === null || sensor.maxValue === undefined
      ? null : Number(sensor.maxValue);
    if ((minValue !== null && !Number.isFinite(minValue)) ||
        (maxValue !== null && !Number.isFinite(maxValue)) ||
        (minValue !== null && maxValue !== null && minValue > maxValue)) {
      throw new Error("Configured sensor range bounds are invalid.");
    }
    if (minValue !== null && value < minValue) {
      throw new Error(`Reading is below the configured minimum (${minValue}).`);
    }
    if (maxValue !== null && value > maxValue) {
      throw new Error(`Reading is above the configured maximum (${maxValue}).`);
    }
    return value;
  }

  function parseControllerStatus(dataView) {
    const fields = bytesToText(dataView).split("|");
    if (fields.length !== 6 || fields[0] !== "NEXORA/1" || fields[1] !== "STATUS" ||
        !["HEATER_READY", "HEATER_UNAVAILABLE"].includes(fields[2]) ||
        !["SENSOR_OK", "SENSOR_FAULT"].includes(fields[3]) ||
        !/^\d+$/.test(fields[4]) || !/^\d+$/.test(fields[5])) {
      throw new Error("Invalid Smart Chamber controller status.");
    }
    return {
      heaterState: fields[2],
      sensorState: fields[3],
      uptimeSeconds: Number(fields[4]),
      bootCount: Number(fields[5])
    };
  }

  function parseControllerAcknowledgement(dataView) {
    const fields = bytesToText(dataView).split("|");
    if (fields.length !== 5 || fields[0] !== "NEXORA/1" || fields[1] !== "ACK" ||
        !/^\d+$/.test(fields[2]) || Number(fields[2]) > 65535 ||
        !["ACCEPTED", "REJECTED"].includes(fields[3]) ||
        !/^[A-Z0-9_]+$/.test(fields[4])) {
      throw new Error("Invalid Smart Chamber command acknowledgement.");
    }
    return {
      sequence: Number(fields[2]),
      result: fields[3],
      reason: fields[4]
    };
  }

  function encodeTargetCommand(sequence, celsius) {
    if (!Number.isInteger(sequence) || sequence < 1 || sequence > 65535) {
      throw new Error("Command sequence must be between 1 and 65535.");
    }
    if (!Number.isFinite(celsius) || celsius < 1 || celsius > 100 ||
        Math.abs(celsius * 2 - Math.round(celsius * 2)) > 0.0001) {
      throw new Error("Target must be between 1°C and 100°C in 0.5°C increments.");
    }
    return `NEXORA/1|SET_TARGET|${sequence}|${Math.round(celsius * 10)}`;
  }

  const api = Object.freeze({
    normalizeUuid,
    isValidUuid,
    isProfileCompatible,
    parseReading,
    parseControllerStatus,
    parseControllerAcknowledgement,
    encodeTargetCommand,
    CONTROL_STATUS_PREFIX,
    CONTROL_ACK_PREFIX
  });
  globalThis.NexoraBleProtocol = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
