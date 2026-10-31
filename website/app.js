(() => {
  "use strict";

  const LEGACY_PROFILE = {
    id: "nexora-legacy-sht4x",
    name: "Existing ESP32 SHT4x",
    serviceUuid: "7b7e0001-7d7a-4f4e-9b8d-2f8c4a6d1000",
    sensors: [
      { name: "Temperature", type: "Temperature", characteristicUuid: "7b7e0002-7d7a-4f4e-9b8d-2f8c4a6d1000", unit: "°C", precision: 2, format: "numeric-text", scale: 1, offset: 0, mode: "notify" },
      { name: "Relative humidity", type: "Humidity", characteristicUuid: "7b7e0003-7d7a-4f4e-9b8d-2f8c4a6d1000", unit: "% RH", precision: 2, format: "numeric-text", scale: 1, offset: 0, mode: "notify" }
    ]
  };
  const SIG_ENVIRONMENTAL_PROFILE = {
    id: "bluetooth-sig-environmental",
    name: "Bluetooth SIG Environmental Sensing",
    serviceUuid: "0000181a-0000-1000-8000-00805f9b34fb",
    sensors: [
      { name: "Temperature", type: "Temperature", characteristicUuid: "00002a6e-0000-1000-8000-00805f9b34fb", unit: "°C", precision: 2, format: "sig-temperature", scale: 1, offset: 0, mode: "read" },
      { name: "Relative humidity", type: "Humidity", characteristicUuid: "00002a6f-0000-1000-8000-00805f9b34fb", unit: "% RH", precision: 2, format: "sig-humidity", scale: 1, offset: 0, mode: "read" }
    ]
  };
  const LEGACY_PROFILE_KEY = "nexora.gatt-profile.v1";
  const PROFILES_KEY = "nexora.gatt-profiles.v2";
  const ACTIVE_PROFILE_KEY = "nexora.active-profile.v2";
  const DEVICE_HISTORY_KEY = "nexora.device-history.v1";
  const SENSOR_LABELS_KEY = "nexora.sensor-labels.v1";
  const MAX_SENSORS = 16;
  const MAX_HISTORY_PER_DEVICE = 5000;
  const STALE_AFTER_MS = 8000;
  const disconnectHandlers = new WeakMap();
  const statusText = document.querySelector("#status");
  const statusDot = document.querySelector("#status-dot");
  const connectButton = document.querySelector("#connect-button");
  const experimentButton = document.querySelector("#experiment-button");
  const exportButton = document.querySelector("#export-button");
  const chart = document.querySelector("#chart");
  const chartContext = chart.getContext("2d");
  const liveChart = document.querySelector("#live-chart");
  const liveChartContext = liveChart.getContext("2d");
  const profileForm = document.querySelector("#profile-form");
  const profileSensors = document.querySelector("#profile-sensors");
  const deviceHistory = document.querySelector("#device-history");
  const menuToggle = document.querySelector("#menu-toggle");
  const primaryNav = document.querySelector("#primary-nav");
  const installButton = document.querySelector("#install-button");
  let savedProfiles = [];
  let activeProfile = null;
  const storedDeviceLabels = readStoredJson(SENSOR_LABELS_KEY, {});
  const deviceLabels = storedDeviceLabels && typeof storedDeviceLabels === "object" && !Array.isArray(storedDeviceLabels)
    ? storedDeviceLabels
    : {};
  const deviceRecords = [];
  const sessionRecords = [];
  const sensorValues = new Map();
  const sensorStates = new Map();
  const characteristicListeners = new Map();
  const readTimers = new Set();
  const lastPackets = new Map();
  const knownServices = [];
  const knownCharacteristics = [];
  const LIVE_SERIES_COLORS = ["#38e6aa", "#47d9ec", "#f0bf68", "#bd91ff", "#ff8088", "#8ddc73"];
  let currentDevice = null;
  let historyDeviceId = null;
  let connectionPhase = { discovered: false, gatt: false, characteristics: false, notifications: false };
  let activeSensors = [];
  let busy = false;
  let logging = false;
  let packetCount = 0;
  let lastTelemetryAt = null;
  let installPrompt = null;
  let selectedRange = 60 * 60 * 1000;
  let liveRange = 60 * 1000;
  let graphPaused = false;
  let graphClearedAt = 0;
  let authorizedDevices = [];
  let persistTimer = null;

  function readStoredJson(key, fallback) {
    let raw;
    try {
      raw = localStorage.getItem(key);
    } catch (error) {
      console.error(`Could not read local NEXORA setting "${key}".`, error);
      setStatus("Browser storage is unavailable; local profiles and history may not persist.", "error");
      return fallback;
    }
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw);
    } catch (error) {
      console.error(`Stored NEXORA data "${key}" is invalid JSON.`, error);
      setStatus("A saved local setting is damaged. Restore the default profile if needed.", "error");
      return fallback;
    }
  }

  function writeStoredJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.error(`Could not save local NEXORA data "${key}".`, error);
      setStatus("Could not save local data in this browser. Check available storage space.", "error");
      return false;
    }
  }

  function normalizedUuid(value) {
    return window.NexoraBleProtocol.normalizeUuid(value);
  }

  function isValidUuid(value) {
    return window.NexoraBleProtocol.isValidUuid(value);
  }

  function normalizeSensor(sensor) {
    if (!sensor || typeof sensor !== "object" ||
        typeof sensor.name !== "string" || !sensor.name.trim() ||
        typeof sensor.type !== "string" || !sensor.type.trim() ||
        typeof sensor.unit !== "string" || !isValidUuid(sensor.characteristicUuid) ||
        !Number.isInteger(sensor.precision) || sensor.precision < 0 || sensor.precision > 6) return null;
    const format = sensor.format || "numeric-text";
    const allowedFormats = ["numeric-text", "json", "csv", "sig-temperature", "sig-humidity",
      "binary-int16", "binary-uint16", "binary-int32", "binary-uint32", "binary-float32", "binary-float64"];
    if (!allowedFormats.includes(format)) return null;
    const mode = sensor.mode || "notify";
    if (!["notify", "read"].includes(mode)) return null;
    const scale = Number(sensor.scale ?? 1);
    const offset = Number(sensor.offset ?? 0);
    if (!Number.isFinite(scale) || !Number.isFinite(offset)) return null;
    const minValue = sensor.minValue === "" || sensor.minValue === undefined || sensor.minValue === null
      ? null : Number(sensor.minValue);
    const maxValue = sensor.maxValue === "" || sensor.maxValue === undefined || sensor.maxValue === null
      ? null : Number(sensor.maxValue);
    if ((minValue !== null && !Number.isFinite(minValue)) ||
        (maxValue !== null && !Number.isFinite(maxValue)) ||
        (minValue !== null && maxValue !== null && minValue > maxValue)) return null;
    const csvColumn = Number(sensor.csvColumn ?? 0);
    const readIntervalMs = Number(sensor.readIntervalMs ?? 2000);
    if (!Number.isInteger(csvColumn) || csvColumn < 0 || csvColumn > 63 ||
        !Number.isInteger(readIntervalMs) || readIntervalMs < 250 || readIntervalMs > 60000) return null;
    return {
      ...sensor,
      name: sensor.name.trim().slice(0, 40),
      type: sensor.type.trim().slice(0, 32),
      unit: sensor.unit.slice(0, 16),
      characteristicUuid: normalizedUuid(sensor.characteristicUuid),
      format,
      mode,
      scale,
      offset,
      minValue,
      maxValue,
      csvColumn,
      csvDelimiter: typeof sensor.csvDelimiter === "string" && sensor.csvDelimiter.length === 1 ? sensor.csvDelimiter : ",",
      jsonPath: typeof sensor.jsonPath === "string" ? sensor.jsonPath.slice(0, 100) : "",
      endianness: sensor.endianness === "big" ? "big" : "little",
      readIntervalMs
    };
  }

  function normalizeProfile(profile, index = 0) {
    if (!profile || typeof profile !== "object" || !isValidUuid(profile.serviceUuid) ||
        !Array.isArray(profile.sensors) || profile.sensors.length === 0 || profile.sensors.length > MAX_SENSORS) return null;
    const sensors = profile.sensors.map(normalizeSensor);
    if (sensors.some(sensor => !sensor) ||
        new Set(sensors.map(sensor => sensor.characteristicUuid)).size !== sensors.length) return null;
    return {
      id: typeof profile.id === "string" && profile.id ? profile.id.slice(0, 80) : `profile-${index + 1}`,
      name: typeof profile.name === "string" && profile.name.trim() ? profile.name.trim().slice(0, 48) : `BLE profile ${index + 1}`,
      serviceUuid: normalizedUuid(profile.serviceUuid),
      sensors
    };
  }

  function loadProfiles() {
    const stored = readStoredJson(PROFILES_KEY, null);
    if (Array.isArray(stored)) {
      const profiles = stored.map(normalizeProfile).filter(Boolean);
      if (profiles.length) return profiles;
      console.error("Saved NEXORA BLE profiles are invalid.");
      setStatus("Saved BLE profiles are invalid. Restore or add a device profile.", "error");
    }
    const old = readStoredJson(LEGACY_PROFILE_KEY, null);
    const migrated = old && normalizeProfile({ ...old, id: "nexora-legacy-sht4x", name: "Existing ESP32 SHT4x" });
    const profiles = migrated ? [migrated] : [structuredClone(LEGACY_PROFILE)];
    profiles.push(structuredClone(SIG_ENVIRONMENTAL_PROFILE));
    return profiles;
  }

  function storeProfiles() {
    return writeStoredJson(PROFILES_KEY, savedProfiles);
  }

  function profileById(id) {
    return savedProfiles.find(profile => profile.id === id) || null;
  }

  function activateProfile(profile) {
    if (!profile) return;
    if (isConnected()) {
      clearGattSubscriptions();
      currentDevice.gatt.disconnect();
    }
    activeProfile = profile;
    writeStoredJson(ACTIVE_PROFILE_KEY, profile.id);
    activeSensors = [];
    sensorValues.clear();
    sensorStates.clear();
    renderProfileSelector();
    renderProfileForm();
    renderSensors();
    renderChartSensorOptions();
    renderLiveGraph();
    updateAnalytics();
    document.querySelector("#service-value").textContent = activeProfile.serviceUuid;
    setStatus(`Selected profile: ${activeProfile.name}. Connect a device to discover its GATT data.`);
  }

  function renderProfileSelector() {
    const select = document.querySelector("#profile-select");
    const currentId = activeProfile?.id;
    select.replaceChildren();
    savedProfiles.forEach(profile => {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = profile.name;
      select.append(option);
    });
    if (currentId && profileById(currentId)) select.value = currentId;
    document.querySelector("#delete-profile-button").disabled = savedProfiles.length <= 1;
  }

  function setStatus(message, state = "") {
    statusText.textContent = message;
    statusDot.classList.toggle("connected", state === "connected");
    statusDot.classList.toggle("error", state === "error");
  }

  function isConnected() {
    return Boolean(currentDevice?.gatt?.connected);
  }

  function sensorStaleAfterMs(sensor) {
    return sensor.mode === "read"
      ? Math.max(STALE_AFTER_MS, sensor.readIntervalMs * 2.5)
      : STALE_AFTER_MS;
  }

  function isFreshReading(sensor, reading, now = Date.now()) {
    return Boolean(reading && now - reading.timestamp <= sensorStaleAfterMs(sensor));
  }

  function updateConnectionUi() {
    const connected = isConnected();
    connectButton.disabled = busy || (!connected && (!window.isSecureContext || !navigator.bluetooth));
    connectButton.textContent = busy ? "Connecting…" : connected ? "Disconnect" : "Connect device";
    document.querySelector("#connection-title").textContent =
      connected ? currentDevice.name || "ESP32 device" : busy ? "Connecting to device…" : "No device connected";
    document.querySelector("#connection-description").textContent =
      connected ? "Bluetooth is connected. Sensor freshness is tracked separately below." :
        "Choose a compatible BLE device to begin receiving telemetry.";
    document.querySelector("#overview-device").textContent = connected ? currentDevice.name || "ESP32 device" : "Not connected";
    document.querySelector("#overview-link").textContent = connected ? "Connected" : "Disconnected";
    experimentButton.disabled = !connected && !logging;
    const savedDeviceCount = readStoredJson(DEVICE_HISTORY_KEY, []);
    document.querySelector("#history-device-select").disabled =
      connected || !Array.isArray(savedDeviceCount) || savedDeviceCount.length <= 1;
    updateSensorHealth();
  }

  function updateConnectionSteps() {
    const now = Date.now();
    const telemetry = activeSensors.some(sensor => {
      const reading = sensorValues.get(sensor.characteristicUuid);
      return isFreshReading(sensor, reading, now);
    });
    const stepStates = {
      discovered: connectionPhase.discovered ? "Device selected" : "Waiting",
      gatt: connectionPhase.gatt && isConnected() ? "Connected" : "Waiting",
      characteristics: connectionPhase.characteristics ? `${activeSensors.length} mapped` : "Waiting",
      notifications: connectionPhase.notifications ? "Ready" : "Not enabled",
      telemetry: telemetry ? "Valid data received" : "Waiting for valid data",
      freshness: telemetry ? "Fresh" : lastTelemetryAt ? "Stale" : "Unavailable"
    };
    document.querySelectorAll("#connection-steps [data-step]").forEach(item => {
      const key = item.dataset.step;
      const detail = item.querySelector("span");
      detail.textContent = stepStates[key] || "Waiting";
      item.classList.toggle("is-complete", ["discovered", "gatt", "characteristics", "notifications", "telemetry"].includes(key)
        ? Boolean(connectionPhase[key === "telemetry" ? "notifications" : key]) && (key !== "telemetry" || telemetry)
        : telemetry);
    });
  }

  function setDiagnostics(lines) {
    const list = document.querySelector("#diagnostics-list");
    list.replaceChildren();
    if (!lines.length) {
      list.textContent = "No service or characteristic discovery details available.";
      return;
    }
    lines.forEach(line => {
      const item = document.createElement("div");
      item.textContent = line;
      list.append(item);
    });
  }

  function liveSeriesSensors() {
    const candidates = activeSensors.length ? activeSensors : activeProfile.sensors;
    const temperature = candidates.find(sensor => /temp/i.test(sensor.type));
    const humidity = candidates.find(sensor => /humid/i.test(sensor.type));
    const matched = [temperature, humidity].filter(Boolean);
    if (matched.length) return [...new Set(matched)];
    const selected = candidates.find(sensor => sensor.characteristicUuid === document.querySelector("#chart-sensor").value)
      || candidates[0]
      || null;
    return selected ? [selected] : [];
  }

  function renderLiveGraph() {
    if (graphPaused) return;
    const rect = liveChart.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const pixelRatio = window.devicePixelRatio || 1;
    liveChart.width = Math.round(rect.width * pixelRatio);
    liveChart.height = Math.round(rect.height * pixelRatio);
    liveChartContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    const width = rect.width;
    const height = rect.height;
    const now = Date.now();
    const start = now - liveRange;
    const left = 57;
    const right = width - 58;
    const top = 18;
    const bottom = height - 31;
    liveChartContext.clearRect(0, 0, width, height);
    liveChartContext.font = '10px "Segoe UI", system-ui, sans-serif';
    liveChartContext.lineWidth = 1;
    liveChartContext.strokeStyle = "#1c2a2e";
    liveChartContext.fillStyle = "#829397";
    liveChartContext.textBaseline = "middle";
    liveChartContext.textAlign = "right";
    for (let index = 0; index <= 4; index++) {
      const y = top + index * (bottom - top) / 4;
      liveChartContext.beginPath();
      liveChartContext.moveTo(left, y);
      liveChartContext.lineTo(right, y);
      liveChartContext.stroke();
    }
    const sensors = liveSeriesSensors();
    const availableRecords = allAvailableRecords();
    const series = sensors.map((sensor, index) => ({
      sensor,
      color: LIVE_SERIES_COLORS[index % LIVE_SERIES_COLORS.length],
      records: availableRecords.filter(record =>
        record.characteristicUuid === sensor.characteristicUuid &&
        Number.isFinite(Date.parse(record.timestamp)) &&
        Date.parse(record.timestamp) >= Math.max(start, graphClearedAt) &&
        Date.parse(record.timestamp) <= now)
    }));
    const nonEmpty = series.filter(item => item.records.length);
    const legend = document.querySelector("#live-chart-legend");
    legend.replaceChildren();
    series.forEach(item => {
      const entry = document.createElement("span");
      entry.className = "live-legend-item";
      const swatch = document.createElement("i");
      swatch.style.backgroundColor = item.color;
      const label = document.createElement("span");
      label.textContent = `${getDisplayName(item.sensor)} (${item.sensor.unit || "unit not set"})${item.sensor === sensors[1] ? " · right axis" : " · left axis"}`;
      entry.append(swatch, label);
      legend.append(entry);
    });
    const empty = document.querySelector("#live-chart-empty");
    empty.hidden = nonEmpty.length > 0;
    empty.textContent = graphPaused ? "Graph paused." :
      activeSensors.length ? "No valid readings in this graph range yet." : "Connect a BLE device and receive valid sensor readings to plot them.";
    const graphFresh = isConnected() && nonEmpty.some(item =>
      item.records.some(record => record.deviceId === currentDevice?.id && now - Date.parse(record.timestamp) <= STALE_AFTER_MS));
    document.querySelector("#live-graph-status").textContent = graphPaused
      ? "Graph paused · telemetry collection continues"
      : nonEmpty.length
        ? `${nonEmpty.reduce((sum, item) => sum + item.records.length, 0)} real samples · ${graphFresh ? "live" : "historical / stale"}`
        : "Waiting for valid telemetry";
    if (!nonEmpty.length) {
      document.querySelector("#live-chart-start").textContent = "—";
      document.querySelector("#live-chart-end").textContent = "—";
      return;
    }
    const minMaxBySeries = series.map(item => {
      const values = item.records.map(record => record.value);
      const min = values.length ? Math.min(...values) : 0;
      const max = values.length ? Math.max(...values) : 1;
      const pad = Math.max((max - min) * .12, Math.abs(max || min || 1) * .01, .01);
      return { min: min - pad, max: max + pad };
    });
    [0, 1, 2, 3, 4].forEach(tick => {
      const y = top + tick * (bottom - top) / 4;
      const fraction = 1 - tick / 4;
      const leftBounds = minMaxBySeries[0];
      if (series[0]) {
        const value = leftBounds.max - fraction * (leftBounds.max - leftBounds.min);
        liveChartContext.textAlign = "right";
        liveChartContext.fillText(value.toFixed(series[0].sensor.precision), left - 8, y);
      }
      if (series[1]) {
        const bounds = minMaxBySeries[1];
        const value = bounds.max - fraction * (bounds.max - bounds.min);
        liveChartContext.textAlign = "left";
        liveChartContext.fillText(value.toFixed(series[1].sensor.precision), right + 8, y);
      }
    });
    series.forEach((item, index) => {
      if (!item.records.length) return;
      const bounds = minMaxBySeries[index];
      const span = bounds.max - bounds.min || 1;
      const maxGap = Math.max(STALE_AFTER_MS * 3, Number(item.sensor.readIntervalMs || 2000) * 2.5);
      liveChartContext.strokeStyle = item.color;
      liveChartContext.fillStyle = item.color;
      liveChartContext.lineWidth = 2;
      liveChartContext.lineJoin = "round";
      liveChartContext.lineCap = "round";
      let previousTime = null;
      let drawing = false;
      item.records.forEach(record => {
        const timestamp = Date.parse(record.timestamp);
        const point = {
          x: left + (timestamp - start) / liveRange * (right - left),
          y: bottom - (record.value - bounds.min) / span * (bottom - top)
        };
        if (!drawing || previousTime === null || timestamp - previousTime > maxGap) {
          liveChartContext.beginPath();
          liveChartContext.moveTo(point.x, point.y);
          drawing = true;
        } else {
          liveChartContext.lineTo(point.x, point.y);
          liveChartContext.stroke();
          liveChartContext.beginPath();
          liveChartContext.moveTo(point.x, point.y);
        }
        liveChartContext.beginPath();
        liveChartContext.arc(point.x, point.y, 2.7, 0, Math.PI * 2);
        liveChartContext.fill();
        previousTime = timestamp;
      });
    });
    const labels = [start, start + liveRange / 2, now].map(timestamp =>
      new Date(timestamp).toLocaleTimeString([], liveRange >= 86400000 ? { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    liveChartContext.textAlign = "left";
    liveChartContext.textBaseline = "top";
    liveChartContext.fillStyle = "#718286";
    liveChartContext.fillText(labels[0], left, bottom + 8);
    liveChartContext.textAlign = "center";
    liveChartContext.fillText(labels[1], (left + right) / 2, bottom + 8);
    liveChartContext.textAlign = "right";
    liveChartContext.fillText(labels[2], right, bottom + 8);
    const timestamps = nonEmpty.flatMap(item => item.records.map(record => Date.parse(record.timestamp)));
    document.querySelector("#live-chart-start").textContent = formatTimestamp(Math.min(...timestamps));
    document.querySelector("#live-chart-end").textContent = formatTimestamp(Math.max(...timestamps));
  }

  function setCapabilityMessage() {
    const note = document.querySelector("#capability-note");
    if (!window.isSecureContext) {
      note.textContent = "Bluetooth requires a secure HTTPS page. Open this site from its GitHub Pages HTTPS address.";
      note.classList.add("error-copy");
      return;
    }
    if (!navigator.bluetooth) {
      note.textContent = "Web Bluetooth is unavailable in this browser. Try a supported Chrome or Edge browser on a BLE-capable device.";
      note.classList.add("error-copy");
      return;
    }
    note.textContent = "Web Bluetooth requires a user gesture and a supported browser. Keep this page open while connected; background BLE and RSSI are not exposed here.";
  }

  function buildField(labelText, className, value, options = {}) {
    const label = document.createElement("label");
    label.className = "field-label";
    const caption = document.createElement("span");
    caption.textContent = labelText;
    const input = document.createElement("input");
    input.className = className;
    input.value = value ?? "";
    input.type = options.type || "text";
    input.required = Boolean(options.required);
    input.autocomplete = "off";
    if (options.maxLength) input.maxLength = options.maxLength;
    if (options.spellcheck === false) input.spellcheck = false;
    if (options.step) input.step = options.step;
    if (options.min !== undefined) input.min = String(options.min);
    if (options.max !== undefined) input.max = String(options.max);
    label.append(caption, input);
    return label;
  }

  function buildSelect(labelText, className, value, options) {
    const label = document.createElement("label");
    label.className = "field-label";
    const caption = document.createElement("span");
    caption.textContent = labelText;
    const select = document.createElement("select");
    select.className = className;
    options.forEach(([optionValue, optionLabel]) => {
      const option = document.createElement("option");
      option.value = optionValue;
      option.textContent = optionLabel;
      select.append(option);
    });
    select.value = value;
    label.append(caption, select);
    return label;
  }

  function addProfileSensorRow(sensor = {}) {
    if (profileSensors.children.length >= MAX_SENSORS) {
      setStatus(`A profile can contain up to ${MAX_SENSORS} sensors.`, "error");
      return;
    }
    const row = document.createElement("div");
    row.className = "profile-sensor-row";
    row.append(
      buildField("Sensor name", "sensor-name-input", sensor.name || "", { required: true, maxLength: 40 }),
      buildField("Type", "sensor-type-input", sensor.type || "Custom", { required: true, maxLength: 32 }),
      buildField("Unit", "sensor-unit-input", sensor.unit || "", { maxLength: 16 }),
      buildField("Decimals", "sensor-precision-input", String(Number.isInteger(sensor.precision) ? sensor.precision : 2), { required: true, maxLength: 1 }),
      buildField("Characteristic UUID", "sensor-uuid-input", sensor.characteristicUuid || "", { required: true, spellcheck: false, maxLength: 40 }),
      buildSelect("Payload format", "sensor-format-input", sensor.format || "numeric-text", [
        ["numeric-text", "UTF-8 number"], ["json", "JSON"], ["csv", "CSV"],
        ["sig-temperature", "SIG temperature (int16 / 0.01°C)"], ["sig-humidity", "SIG humidity (uint16 / 0.01%)"],
        ["binary-int16", "Binary int16"], ["binary-uint16", "Binary uint16"],
        ["binary-int32", "Binary int32"], ["binary-uint32", "Binary uint32"],
        ["binary-float32", "Binary float32"], ["binary-float64", "Binary float64"]
      ]),
      buildSelect("Access mode", "sensor-mode-input", sensor.mode || "notify", [["notify", "Notify / indicate"], ["read", "Periodic read"]]),
      buildField("Scale", "sensor-scale-input", sensor.scale ?? 1, { required: true, type: "number", step: "any" }),
      buildField("Offset", "sensor-offset-input", sensor.offset ?? 0, { required: true, type: "number", step: "any" }),
      buildSelect("Byte order", "sensor-endianness-input", sensor.endianness || "little", [["little", "Little-endian"], ["big", "Big-endian"]]),
      buildField("JSON field path", "sensor-json-path-input", sensor.jsonPath || "", { maxLength: 100 }),
      buildField("CSV column (1-based)", "sensor-csv-column-input", Number(sensor.csvColumn || 0) + 1, { required: true, type: "number", min: 1, max: 64, step: 1 }),
      buildField("CSV delimiter", "sensor-csv-delimiter-input", sensor.csvDelimiter || ",", { required: true, maxLength: 1 }),
      buildField("Min value (optional)", "sensor-min-input", sensor.minValue ?? "", { type: "number", step: "any" }),
      buildField("Max value (optional)", "sensor-max-input", sensor.maxValue ?? "", { type: "number", step: "any" }),
      buildField("Read interval ms", "sensor-interval-input", sensor.readIntervalMs ?? 2000, { required: true, type: "number", min: 250, max: 60000, step: 250 })
    );
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-sensor";
    remove.dataset.action = "remove-sensor";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${sensor.name || "sensor"} from profile`);
    row.append(remove);
    profileSensors.append(row);
  }

  function renderProfileForm() {
    document.querySelector("#profile-name").value = activeProfile.name;
    document.querySelector("#service-uuid").value = activeProfile.serviceUuid;
    profileSensors.replaceChildren();
    activeProfile.sensors.forEach(addProfileSensorRow);
    document.querySelector("#service-value").textContent = activeProfile.serviceUuid;
  }

  function collectProfileFromForm() {
    const serviceUuid = normalizedUuid(document.querySelector("#service-uuid").value);
    if (!isValidUuid(serviceUuid)) throw new Error("Enter a valid 128-bit service UUID.");
    const profileName = document.querySelector("#profile-name").value.trim();
    if (!profileName) throw new Error("Enter a profile name.");
    const rows = [...profileSensors.querySelectorAll(".profile-sensor-row")];
    if (rows.length === 0 || rows.length > MAX_SENSORS) {
      throw new Error(`Configure between 1 and ${MAX_SENSORS} sensor characteristics.`);
    }
    const sensors = rows.map((row, index) => {
      const name = row.querySelector(".sensor-name-input").value.trim();
      const type = row.querySelector(".sensor-type-input").value.trim();
      const unit = row.querySelector(".sensor-unit-input").value.trim();
      const precisionText = row.querySelector(".sensor-precision-input").value.trim();
      const characteristicUuid = normalizedUuid(row.querySelector(".sensor-uuid-input").value);
      const precision = Number(precisionText);
      if (!name || !type) throw new Error(`Sensor ${index + 1} needs a name and type.`);
      if (!isValidUuid(characteristicUuid)) throw new Error(`Sensor ${index + 1} needs a valid 128-bit characteristic UUID.`);
      if (!Number.isInteger(precision) || precision < 0 || precision > 6) throw new Error(`Sensor ${index + 1} precision must be 0–6.`);
      const rowValue = selector => row.querySelector(selector).value.trim();
      const csvColumn = Number(rowValue(".sensor-csv-column-input")) - 1;
      const readIntervalMs = Number(rowValue(".sensor-interval-input"));
      const scale = Number(rowValue(".sensor-scale-input"));
      const offset = Number(rowValue(".sensor-offset-input"));
      const minValue = rowValue(".sensor-min-input");
      const maxValue = rowValue(".sensor-max-input");
      if (!Number.isInteger(csvColumn) || csvColumn < 0 || csvColumn > 63) throw new Error(`Sensor ${index + 1} CSV column must be between 1 and 64.`);
      if (!Number.isInteger(readIntervalMs) || readIntervalMs < 250 || readIntervalMs > 60000) throw new Error(`Sensor ${index + 1} read interval must be 250–60000 ms.`);
      if (!Number.isFinite(scale) || !Number.isFinite(offset)) throw new Error(`Sensor ${index + 1} scale and offset must be finite numbers.`);
      if ((minValue && !Number.isFinite(Number(minValue))) || (maxValue && !Number.isFinite(Number(maxValue)))) {
        throw new Error(`Sensor ${index + 1} range bounds must be finite numbers.`);
      }
      if (minValue && maxValue && Number(minValue) > Number(maxValue)) throw new Error(`Sensor ${index + 1} minimum must not exceed its maximum.`);
      const csvDelimiter = rowValue(".sensor-csv-delimiter-input");
      if (csvDelimiter.length !== 1) throw new Error(`Sensor ${index + 1} CSV delimiter must be one character.`);
      return {
        name, type, unit, precision, characteristicUuid,
        format: rowValue(".sensor-format-input"),
        mode: rowValue(".sensor-mode-input"),
        scale, offset,
        endianness: rowValue(".sensor-endianness-input"),
        jsonPath: rowValue(".sensor-json-path-input"),
        csvColumn, csvDelimiter,
        minValue: minValue ? Number(minValue) : null,
        maxValue: maxValue ? Number(maxValue) : null,
        readIntervalMs
      };
    });
    const characteristicUuids = sensors.map(sensor => sensor.characteristicUuid);
    if (new Set(characteristicUuids).size !== characteristicUuids.length) {
      throw new Error("Each sensor must use a different characteristic UUID.");
    }
    return { id: activeProfile.id, name: profileName, serviceUuid, sensors };
  }

  function saveProfile(event) {
    event.preventDefault();
    let nextProfile;
    try {
      nextProfile = normalizeProfile(collectProfileFromForm());
      if (!nextProfile) throw new Error("The BLE profile contains invalid sensor mappings.");
    } catch (error) {
      setStatus(error.message, "error");
      return;
    }
    const existingIndex = savedProfiles.findIndex(profile => profile.id === nextProfile.id);
    if (existingIndex < 0) savedProfiles.push(nextProfile);
    else savedProfiles.splice(existingIndex, 1, nextProfile);
    if (!storeProfiles()) return;
    if (nextProfile.id === LEGACY_PROFILE.id) writeStoredJson(LEGACY_PROFILE_KEY, nextProfile);
    activateProfile(nextProfile);
    setStatus(`Profile "${nextProfile.name}" saved locally.`);
  }

  function restoreDefaultProfile() {
    const restored = structuredClone(LEGACY_PROFILE);
    const index = savedProfiles.findIndex(profile => profile.id === restored.id);
    if (index < 0) savedProfiles.push(restored);
    else savedProfiles.splice(index, 1, restored);
    if (!storeProfiles()) return;
    writeStoredJson(LEGACY_PROFILE_KEY, restored);
    activateProfile(restored);
    setStatus("Existing ESP32 SHT4x profile restored.");
  }

  function createNewProfile() {
    const profile = {
      id: `custom-${window.crypto?.randomUUID?.() || Date.now().toString(36)}`,
      name: "New BLE profile",
      serviceUuid: "",
      sensors: []
    };
    const existing = document.querySelector("#profile-select");
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    existing.append(option);
    activeProfile = profile;
    activeSensors = [];
    sensorValues.clear();
    sensorStates.clear();
    renderProfileForm();
    profileSensors.replaceChildren();
    addProfileSensorRow({ name: "Temperature", type: "Temperature", unit: "°C", precision: 2, format: "numeric-text", mode: "notify" });
    document.querySelector("#profile-select").value = profile.id;
    renderSensors();
    renderChartSensorOptions();
    updateAnalytics();
  }

  function applyPreset(preset) {
    let profile = profileById(preset.id);
    if (!profile) {
      profile = structuredClone(preset);
      savedProfiles.push(profile);
      if (!storeProfiles()) return;
    }
    activateProfile(profile);
    document.querySelector("#profile-details").open = true;
  }

  function deleteActiveProfile() {
    if (savedProfiles.length <= 1) {
      setStatus("Keep at least one saved BLE profile.", "error");
      return;
    }
    const removedName = activeProfile.name;
    savedProfiles = savedProfiles.filter(profile => profile.id !== activeProfile.id);
    if (!storeProfiles()) return;
    activateProfile(savedProfiles[0]);
    setStatus(`Removed saved profile "${removedName}".`);
  }

  function formatTimestamp(timestamp) {
    if (!Number.isFinite(timestamp)) return "—";
    return new Date(timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }

  function formatRelative(timestamp) {
    if (!Number.isFinite(timestamp)) return "No reading received";
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    return seconds < 2 ? "Just now" : `${seconds}s ago`;
  }

  function getDisplayName(sensor) {
    return typeof deviceLabels[sensor.characteristicUuid] === "string"
      ? deviceLabels[sensor.characteristicUuid]
      : sensor.name;
  }

  function renderSensors() {
    const grid = document.querySelector("#sensor-grid");
    const count = document.querySelector("#sensor-count");
    if (!isConnected() || activeSensors.length === 0) {
      grid.replaceChildren();
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const icon = document.createElement("span");
      icon.className = "empty-icon";
      icon.textContent = "⌁";
      const heading = document.createElement("strong");
      heading.textContent = "Waiting for a device";
      const description = document.createElement("p");
      description.textContent = "Connect an ESP32 to populate this area with its configured sensor readings.";
      empty.append(icon, heading, description);
      grid.append(empty);
      count.textContent = "No device data yet";
      return;
    }
    grid.replaceChildren();
    activeSensors.forEach(sensor => {
      const card = document.createElement("article");
      card.className = "sensor-card";
      card.dataset.sensorUuid = sensor.characteristicUuid;
      const top = document.createElement("div");
      top.className = "sensor-card-top";
      const nameWrap = document.createElement("div");
      nameWrap.className = "sensor-name-wrap";
      const name = document.createElement("div");
      name.className = "sensor-name";
      name.dataset.role = "sensor-name";
      name.textContent = getDisplayName(sensor);
      const type = document.createElement("div");
      type.className = "sensor-type";
      type.dataset.role = "sensor-type";
      type.textContent = sensor.type;
      nameWrap.append(name, type);
      const health = document.createElement("span");
      health.className = "sensor-health";
      health.dataset.role = "sensor-health";
      health.textContent = "Waiting";
      top.append(nameWrap, health);
      const reading = document.createElement("div");
      reading.className = "sensor-reading";
      const value = document.createElement("strong");
      value.dataset.role = "sensor-value";
      value.textContent = "—";
      const unit = document.createElement("span");
      unit.dataset.role = "sensor-unit";
      unit.textContent = sensor.unit;
      reading.append(value, unit);
      const last = document.createElement("div");
      last.className = "sensor-last";
      last.dataset.role = "sensor-last";
      last.textContent = "No reading received";
      const rename = document.createElement("button");
      rename.type = "button";
      rename.className = "rename-button";
      rename.dataset.action = "rename-sensor";
      rename.textContent = "Edit display name";
      card.append(top, reading, last, rename);
      grid.append(card);
      updateSensorCard(sensor);
    });
    count.textContent = `${activeSensors.length} configured sensor${activeSensors.length === 1 ? "" : "s"} · ${packetCount} BLE packets`;
  }

  function updateSensorCard(sensor) {
    const card = document.querySelector(`.sensor-card[data-sensor-uuid="${CSS.escape(sensor.characteristicUuid)}"]`);
    if (!card) return;
    card.querySelector('[data-role="sensor-name"]').textContent = getDisplayName(sensor);
    const state = sensorStates.get(sensor.characteristicUuid);
    const reading = sensorValues.get(sensor.characteristicUuid);
    const health = card.querySelector('[data-role="sensor-health"]');
    health.classList.remove("is-fresh", "is-stale", "is-invalid");
    if (state === "invalid") {
      health.textContent = "Invalid data";
      health.classList.add("is-invalid");
    } else if (isFreshReading(sensor, reading) && isConnected()) {
      health.textContent = "Live";
      health.classList.add("is-fresh");
    } else if (reading) {
      health.textContent = "Stale";
      health.classList.add("is-stale");
    } else {
      health.textContent = isConnected() ? "Waiting" : "Unavailable";
    }
    card.querySelector('[data-role="sensor-value"]').textContent =
      reading ? reading.value.toFixed(sensor.precision) : "—";
    card.querySelector('[data-role="sensor-unit"]').textContent = sensor.unit;
    card.querySelector('[data-role="sensor-last"]').textContent =
      reading ? `Last received ${formatRelative(reading.timestamp)} · ${formatTimestamp(reading.timestamp)}` : "No reading received";
  }

  function updateSensorHealth() {
    activeSensors.forEach(updateSensorCard);
    const connected = isConnected();
    const latest = lastTelemetryAt ? formatRelative(lastTelemetryAt) : "—";
    document.querySelector("#last-telemetry").textContent = latest;
    const now = Date.now();
    const fresh = activeSensors.some(sensor => isFreshReading(sensor, sensorValues.get(sensor.characteristicUuid), now));
    if (connected && fresh) setStatus("BLE connected · telemetry is live", "connected");
    else if (connected && lastTelemetryAt) setStatus("BLE connected · telemetry is stale", "connected");
    updateConnectionSteps();
    renderLiveGraph();
    if (activeSensors.length) {
      document.querySelector("#sensor-count").textContent =
        `${activeSensors.length} configured sensor${activeSensors.length === 1 ? "" : "s"} · ${packetCount} BLE packets`;
    }
  }

  function handleInvalidValue(sensor, message) {
    sensorStates.set(sensor.characteristicUuid, "invalid");
    updateSensorCard(sensor);
    setStatus(`${getDisplayName(sensor)}: ${message}`, isConnected() ? "connected" : "error");
  }

  function handleSensorValue(sensor, dataView) {
    let value;
    try {
      value = window.NexoraBleProtocol.parseReading(sensor, dataView);
    } catch (error) {
      handleInvalidValue(sensor, error.message || "Invalid sensor payload.");
      return;
    }
    const timestamp = Date.now();
    const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
    const fingerprint = [...bytes].join(",");
    const previousPacket = lastPackets.get(sensor.characteristicUuid);
    if (previousPacket?.fingerprint === fingerprint && timestamp - previousPacket.timestamp < 100) return;
    lastPackets.set(sensor.characteristicUuid, { fingerprint, timestamp });
    const reading = {
      timestamp: new Date(timestamp).toISOString(),
      characteristicUuid: sensor.characteristicUuid,
      sensorName: getDisplayName(sensor),
      sensorType: sensor.type,
      deviceId: currentDevice?.id || historyDeviceId,
      value,
      unit: sensor.unit
    };
    sensorValues.set(sensor.characteristicUuid, { value, timestamp });
    sensorStates.set(sensor.characteristicUuid, "valid");
    lastTelemetryAt = timestamp;
    document.querySelector("#packet-count").textContent = String(packetCount);
    sessionRecords.push(reading);
    if (sessionRecords.length > MAX_HISTORY_PER_DEVICE) sessionRecords.shift();
    if (logging) {
      deviceRecords.push(reading);
      if (deviceRecords.length > MAX_HISTORY_PER_DEVICE) deviceRecords.splice(0, deviceRecords.length - MAX_HISTORY_PER_DEVICE);
      persistDeviceRecords();
      document.querySelector("#row-count").textContent =
        `${deviceRecords.length} actual sensor samples stored on this device.`;
      exportButton.disabled = deviceRecords.length === 0;
    }
    updateSensorCard(sensor);
    updateSensorHealth();
    updateConnectionSteps();
    renderLiveGraph();
    updateAnalytics();
  }

  function persistDeviceRecords() {
    if (!currentDevice?.id || currentDevice.id !== historyDeviceId || persistTimer !== null) return;
    persistTimer = window.setTimeout(() => {
      persistTimer = null;
      writeStoredJson(historyStorageKey(currentDevice.id), deviceRecords);
    }, 750);
  }

  function flushDeviceRecords() {
    if (persistTimer !== null) {
      window.clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (historyDeviceId) writeStoredJson(historyStorageKey(historyDeviceId), deviceRecords);
  }

  function historyStorageKey(deviceId) {
    return `nexora.readings.v1.${encodeURIComponent(deviceId)}`;
  }

  function loadDeviceRecords(deviceId) {
    historyDeviceId = deviceId || null;
    const select = document.querySelector("#history-device-select");
    if (select && deviceId) select.value = deviceId;
    const records = readStoredJson(historyStorageKey(deviceId), []);
    if (!Array.isArray(records)) {
      console.error("Saved sensor history for this device is not an array.");
      setStatus("Saved history is damaged and cannot be displayed.", "error");
      deviceRecords.splice(0);
      return;
    }
    const validRecords = records.filter(record =>
      record && typeof record.timestamp === "string" &&
      typeof record.characteristicUuid === "string" &&
      Number.isFinite(record.value) && typeof record.unit === "string" &&
      Number.isFinite(Date.parse(record.timestamp))
    ).slice(-MAX_HISTORY_PER_DEVICE);
    deviceRecords.splice(0, deviceRecords.length, ...validRecords);
    const latest = validRecords.reduce((maximum, record) => Math.max(maximum, Date.parse(record.timestamp)), 0);
    lastTelemetryAt = latest || null;
    document.querySelector("#last-telemetry").textContent = latest ? formatRelative(latest) : "—";
    document.querySelector("#row-count").textContent =
      `${deviceRecords.length} saved sensor sample${deviceRecords.length === 1 ? "" : "s"} for this device.`;
    exportButton.disabled = deviceRecords.length === 0;
  }

  function allAvailableRecords() {
    const records = [
      ...deviceRecords,
      ...sessionRecords.filter(record => record.deviceId === historyDeviceId)
    ];
    const unique = new Map();
    records.forEach(record => {
      const key = `${record.timestamp}|${record.characteristicUuid}|${record.value}`;
      unique.set(key, record);
    });
    return [...unique.values()].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  }

  function renderChartSensorOptions() {
    const select = document.querySelector("#chart-sensor");
    const previous = select.value;
    select.replaceChildren();
    activeProfile.sensors.forEach(sensor => {
      const option = document.createElement("option");
      option.value = sensor.characteristicUuid;
      option.textContent = getDisplayName(sensor);
      select.append(option);
    });
    if (previous && activeProfile.sensors.some(sensor => sensor.characteristicUuid === previous)) select.value = previous;
    select.disabled = activeProfile.sensors.length === 0;
  }

  function selectedSensor() {
    return activeProfile.sensors.find(sensor => sensor.characteristicUuid === document.querySelector("#chart-sensor").value)
      || activeProfile.sensors[0]
      || null;
  }

  function updateAnalytics() {
    const sensor = selectedSensor();
    const now = Date.now();
    const start = now - selectedRange;
    const records = sensor
      ? allAvailableRecords().filter(record =>
        record.characteristicUuid === sensor.characteristicUuid &&
        record.unit === sensor.unit &&
        record.sensorType === sensor.type &&
        Number.isFinite(Date.parse(record.timestamp)) &&
        Date.parse(record.timestamp) >= start &&
        Date.parse(record.timestamp) <= now)
      : [];
    const rangeLabels = new Map([
      [60000, "1 minute"], [300000, "5 minutes"], [1800000, "30 minutes"],
      [3600000, "1 hour"], [86400000, "24 hours"]
    ]);
    const label = rangeLabels.get(selectedRange) || "selected range";
    document.querySelector("#chart-range-label").textContent =
      records.length ? `${records.length} real sample${records.length === 1 ? "" : "s"} · ${label}` : `No readings in the last ${label}`;
    document.querySelector("#chart-empty").hidden = records.length > 0;
    document.querySelector("#chart-empty").textContent =
      "No stored readings in this range. Start logging while connected.";
    if (!records.length) {
      document.querySelector("#stat-min").textContent = "—";
      document.querySelector("#stat-max").textContent = "—";
      document.querySelector("#stat-average").textContent = "—";
      document.querySelector("#stat-count").textContent = "0";
      document.querySelector("#chart-start").textContent = "—";
      document.querySelector("#chart-end").textContent = "—";
      drawChart([]);
      return;
    }
    const values = records.map(record => record.value);
    const format = value => `${value.toFixed(sensor.precision)}${sensor.unit ? ` ${sensor.unit}` : ""}`;
    document.querySelector("#stat-min").textContent = format(Math.min(...values));
    document.querySelector("#stat-max").textContent = format(Math.max(...values));
    document.querySelector("#stat-average").textContent = format(values.reduce((sum, value) => sum + value, 0) / values.length);
    document.querySelector("#stat-count").textContent = String(records.length);
    document.querySelector("#chart-start").textContent = formatTimestamp(Date.parse(records[0].timestamp));
    document.querySelector("#chart-end").textContent = formatTimestamp(Date.parse(records[records.length - 1].timestamp));
    drawChart(records);
  }

  function drawChart(records) {
    const rect = chart.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const pixelRatio = window.devicePixelRatio || 1;
    chart.width = Math.round(rect.width * pixelRatio);
    chart.height = Math.round(rect.height * pixelRatio);
    chartContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    const width = rect.width;
    const height = rect.height;
    const left = 38;
    const right = width - 12;
    const top = 14;
    const bottom = height - 19;
    chartContext.clearRect(0, 0, width, height);
    chartContext.font = '9px "Segoe UI", system-ui, sans-serif';
    chartContext.lineWidth = 1;
    for (let index = 0; index < 4; index++) {
      const y = top + index * (bottom - top) / 3;
      chartContext.strokeStyle = "#1c2a2e";
      chartContext.beginPath();
      chartContext.moveTo(left, y);
      chartContext.lineTo(right, y);
      chartContext.stroke();
    }
    if (!records.length) return;
    const values = records.map(record => record.value);
    const low = Math.min(...values);
    const high = Math.max(...values);
    const padding = Math.max((high - low) * .12, Math.abs(high || low || 1) * .01, .01);
    const minimum = low - padding;
    const span = Math.max(high - low + padding * 2, .02);
    chartContext.fillStyle = "#788b8f";
    chartContext.textAlign = "right";
    chartContext.textBaseline = "middle";
    [high, (high + low) / 2, low].forEach((value, index) => {
      const y = top + index * (bottom - top) / 2;
      chartContext.fillText(value.toFixed(2), left - 8, y);
    });
    const points = records.map((record, index) => ({
      x: records.length === 1 ? (left + right) / 2 : left + index * (right - left) / (records.length - 1),
      y: bottom - (record.value - minimum) / span * (bottom - top)
    }));
    chartContext.beginPath();
    points.forEach((point, index) => index === 0 ? chartContext.moveTo(point.x, point.y) : chartContext.lineTo(point.x, point.y));
    chartContext.strokeStyle = "#35e7b0";
    chartContext.lineWidth = 2;
    chartContext.lineJoin = "round";
    chartContext.lineCap = "round";
    chartContext.stroke();
    chartContext.fillStyle = "#31e4aa";
    points.forEach(point => {
      chartContext.beginPath();
      chartContext.arc(point.x, point.y, 2.5, 0, Math.PI * 2);
      chartContext.fill();
    });
  }

  function exportCsv() {
    const records = [...deviceRecords].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
    if (!records.length) {
      setStatus("No logged readings are available to export.", "error");
      return;
    }
    const savedDevices = readStoredJson(DEVICE_HISTORY_KEY, []);
    const historyDevice = Array.isArray(savedDevices) && savedDevices.find(item => item?.id === historyDeviceId);
    const deviceName = currentDevice?.id === historyDeviceId
      ? displayDeviceName(currentDevice)
      : historyDevice?.name || "BLE device";
    const rows = [
      ["Timestamp", "Device", "Sensor", "Type", "Characteristic_UUID", "Value", "Unit"],
      ...records.map(record => [
        record.timestamp,
        deviceName,
        record.sensorName,
        record.sensorType,
        record.characteristicUuid,
        record.value,
        record.unit
      ])
    ];
    const csv = rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "nexora_sensor_history.csv";
    link.click();
    URL.revokeObjectURL(url);
    setStatus(`Exported ${records.length} logged sensor samples.`, isConnected() ? "connected" : "");
  }

  function rememberDevice(device) {
    if (!device?.id) return;
    const saved = readStoredJson(DEVICE_HISTORY_KEY, []);
    if (!Array.isArray(saved)) {
      console.error("Saved NEXORA device history is not an array.");
      setStatus("Saved device history is damaged and cannot be updated.", "error");
      return;
    }
    const previous = saved.find(item => item && item.id === device.id);
    const next = [{
      id: device.id,
      name: previous?.name || device.name || "BLE device",
      profileId: activeProfile.id,
      serviceUuid: activeProfile.serviceUuid,
      lastConnected: new Date().toISOString()
    }, ...saved.filter(item => item && item.id !== device.id)].slice(0, 20);
    writeStoredJson(DEVICE_HISTORY_KEY, next);
    renderDeviceHistory(next);
    renderHistoryDeviceSelector(next);
  }

  function renderHistoryDeviceSelector(saved = readStoredJson(DEVICE_HISTORY_KEY, [])) {
    const select = document.querySelector("#history-device-select");
    const previous = historyDeviceId;
    select.replaceChildren();
    if (!Array.isArray(saved) || saved.length === 0) {
      const option = document.createElement("option");
      option.textContent = "No saved devices";
      option.value = "";
      select.append(option);
      select.disabled = true;
      return;
    }
    saved.forEach(item => {
      const option = document.createElement("option");
      option.value = item.id;
      const profile = profileById(item.profileId);
      option.textContent = `${item.name || "BLE device"}${profile ? ` · ${profile.name}` : ""}`;
      select.append(option);
    });
    const selected = previous && saved.some(item => item.id === previous) ? previous : saved[0].id;
    select.value = selected;
    select.disabled = isConnected() || saved.length <= 1;
  }

  function renderDeviceHistory(saved = readStoredJson(DEVICE_HISTORY_KEY, [])) {
    renderHistoryDeviceSelector(saved);
    deviceHistory.replaceChildren();
    if (!Array.isArray(saved) || saved.length === 0) {
      const empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = "No connection history yet.";
      deviceHistory.append(empty);
      return;
    }
    saved.forEach(item => {
      const row = document.createElement("div");
      row.className = "history-item";
      const copy = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = item.name || "ESP32 device";
      const last = document.createElement("span");
      const profile = profileById(item.profileId);
      last.textContent = `${profile ? `Profile: ${profile.name} · ` : ""}Last connected ${formatTimestamp(Date.parse(item.lastConnected))}`;
      copy.append(name, last);
      row.append(copy);
      const permitted = authorizedDevices.find(authorized => authorized.id === item.id);
      if (permitted) {
        const reconnect = document.createElement("button");
        reconnect.type = "button";
        reconnect.className = "button button-outline";
        reconnect.dataset.deviceId = permitted.id;
        reconnect.textContent = "Reconnect";
        row.append(reconnect);
      }
      const rename = document.createElement("button");
      rename.type = "button";
      rename.className = "button button-quiet";
      rename.dataset.renameDeviceId = item.id;
      rename.textContent = "Rename";
      row.append(rename);
      const forget = document.createElement("button");
      forget.type = "button";
      forget.className = "button button-quiet";
      forget.dataset.forgetDeviceId = item.id;
      forget.textContent = "Forget";
      row.append(forget);
      deviceHistory.append(row);
    });
  }

  function displayDeviceName(device) {
    if (!device?.id) return device?.name || "BLE device";
    const saved = readStoredJson(DEVICE_HISTORY_KEY, []);
    const entry = Array.isArray(saved) && saved.find(item => item?.id === device.id);
    return entry?.name || device.name || "BLE device";
  }

  function updateSavedDevice(deviceId, updates) {
    const saved = readStoredJson(DEVICE_HISTORY_KEY, []);
    if (!Array.isArray(saved)) {
      setStatus("Saved device list is invalid and could not be updated.", "error");
      return false;
    }
    const index = saved.findIndex(item => item?.id === deviceId);
    if (index < 0) return false;
    saved[index] = { ...saved[index], ...updates };
    if (!writeStoredJson(DEVICE_HISTORY_KEY, saved)) return false;
    renderDeviceHistory(saved);
    return true;
  }

  function renameDevice(deviceId, proposedName) {
    const name = proposedName.trim().slice(0, 40);
    if (!name) {
      setStatus("Saved device name cannot be empty.", "error");
      return;
    }
    if (!updateSavedDevice(deviceId, { name })) return;
    if (currentDevice?.id === deviceId) {
      document.querySelector("#device-name").textContent = name;
      document.querySelector("#device-alias").value = name;
      renderSensors();
    }
    setStatus(`Saved device name changed to "${name}".`);
  }

  function forgetDevice(deviceId) {
    if (isConnected() && currentDevice?.id === deviceId) {
      setStatus("Disconnect this device before forgetting its saved connection.", "error");
      return;
    }
    const saved = readStoredJson(DEVICE_HISTORY_KEY, []);
    if (!Array.isArray(saved)) {
      setStatus("Saved device list is invalid and could not be changed.", "error");
      return;
    }
    const next = saved.filter(item => item?.id !== deviceId);
    if (!writeStoredJson(DEVICE_HISTORY_KEY, next)) return;
    renderDeviceHistory(next);
    if (historyDeviceId === deviceId) {
      const nextDeviceId = next[0]?.id || null;
      if (nextDeviceId) {
        loadDeviceRecords(nextDeviceId);
        const nextEntry = next.find(item => item.id === nextDeviceId);
        const profile = profileById(nextEntry?.profileId);
        if (profile) activateProfile(profile);
      }
      else {
        historyDeviceId = null;
        deviceRecords.splice(0);
      }
      updateAnalytics();
      renderLiveGraph();
    }
    setStatus("Saved device profile forgotten. Previously stored readings remain in this browser.");
  }

  async function refreshAuthorizedDevices() {
    if (!navigator.bluetooth?.getDevices) {
      authorizedDevices = [];
      renderDeviceHistory();
      return;
    }
    try {
      authorizedDevices = await navigator.bluetooth.getDevices();
      renderDeviceHistory();
    } catch (error) {
      console.error("Could not list previously authorized Bluetooth devices.", error);
      setStatus(`Could not read saved Bluetooth permissions: ${error.message || error.name}`, "error");
    }
  }

  async function withTimeout(promise, milliseconds, label) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = window.setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds / 1000} seconds.`)), milliseconds);
        })
      ]);
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function discoverGattCapabilities(server) {
    knownServices.splice(0);
    knownCharacteristics.splice(0);
    const details = [];
    try {
      const services = await withTimeout(server.getPrimaryServices(), 10000, "GATT service discovery");
      for (const service of services) {
        knownServices.push(service.uuid);
        let characteristics;
        try {
          characteristics = await withTimeout(service.getCharacteristics(), 10000, "GATT characteristic discovery");
        } catch (error) {
          details.push(`Service ${service.uuid}: characteristic discovery failed (${error.message || error.name}).`);
          continue;
        }
        details.push(`Service ${service.uuid}`);
        for (const characteristic of characteristics) {
          const props = ["read", "notify", "indicate", "write", "writeWithoutResponse"]
            .filter(property => characteristic.properties[property]);
          knownCharacteristics.push({ serviceUuid: service.uuid, uuid: characteristic.uuid, properties: props });
          details.push(`  ${characteristic.uuid} · ${props.length ? props.join(", ") : "no supported properties"}`);
        }
      }
    } catch (error) {
      details.push(`Service discovery failed: ${error.message || error.name}. Confirm this service is included in the device permission request.`);
    }
    setDiagnostics(details);
    return details;
  }

  async function connectDevice(device) {
    if (busy) return;
    flushDeviceRecords();
    clearGattSubscriptions();
    busy = true;
    currentDevice = device;
    connectionPhase = { discovered: true, gatt: false, characteristics: false, notifications: false };
    activeSensors = [];
    sensorValues.clear();
    sensorStates.clear();
    lastPackets.clear();
    updateConnectionUi();
    updateConnectionSteps();
    setStatus(`Device selected · connecting to ${displayDeviceName(device)}…`);
    loadDeviceRecords(device.id);
    if (logging) {
      logging = false;
      experimentButton.textContent = "Start logging";
      document.querySelector("#experiment-title").textContent = "Session logging is off";
    }
    sessionRecords.splice(0);
    exportButton.disabled = true;
    document.querySelector("#row-count").textContent = "Waiting for telemetry from this device.";
    packetCount = 0;
    lastTelemetryAt = null;
    document.querySelector("#packet-count").textContent = "0";
    document.querySelector("#reconnect-button").hidden = true;
    setDiagnostics([]);
    try {
      if (!device.gatt) throw new Error("This Bluetooth device does not expose a GATT server.");
      const server = await withTimeout(device.gatt.connect(), 15000, "GATT connection");
      connectionPhase.gatt = true;
      updateConnectionUi();
      setStatus(`GATT connected · discovering ${activeProfile.name} characteristics…`, "connected");
      const details = await discoverGattCapabilities(server);
      const service = await withTimeout(server.getPrimaryService(activeProfile.serviceUuid), 10000, "Configured GATT service lookup");
      const available = [];
      const unavailable = [];
      for (const sensor of activeProfile.sensors) {
        try {
          const characteristic = await withTimeout(service.getCharacteristic(sensor.characteristicUuid), 10000, `${sensor.name} characteristic lookup`);
          const supportsNotifications = characteristic.properties.notify || characteristic.properties.indicate;
          if (sensor.mode === "notify" && supportsNotifications) {
            const handler = event => {
              packetCount += 1;
              document.querySelector("#packet-count").textContent = String(packetCount);
              handleSensorValue(sensor, event.target.value);
            };
            const previous = characteristicListeners.get(sensor.characteristicUuid);
            if (previous) previous.characteristic.removeEventListener("characteristicvaluechanged", previous.handler);
            characteristic.addEventListener("characteristicvaluechanged", handler);
            characteristicListeners.set(sensor.characteristicUuid, { characteristic, handler });
            try {
              await withTimeout(characteristic.startNotifications(), 10000, `${sensor.name} notification subscription`);
            } catch (error) {
              characteristic.removeEventListener("characteristicvaluechanged", handler);
              characteristicListeners.delete(sensor.characteristicUuid);
              try {
                await characteristic.stopNotifications();
              } catch (stopError) {
                console.error(`Could not clean up ${sensor.name} notification subscription.`, stopError);
              }
              throw error;
            }
          } else if (sensor.mode === "read" && characteristic.properties.read) {
            await withTimeout(characteristic.readValue(), 10000, `${sensor.name} initial read`);
            packetCount += 1;
            document.querySelector("#packet-count").textContent = String(packetCount);
            handleSensorValue(sensor, characteristic.value);
            let readInFlight = false;
            const timer = window.setInterval(async () => {
              if (readInFlight) return;
              if (!isConnected() || currentDevice !== device) return;
              readInFlight = true;
              try {
                await withTimeout(characteristic.readValue(), 10000, `${sensor.name} periodic read`);
                if (!isConnected() || currentDevice !== device) return;
                packetCount += 1;
                document.querySelector("#packet-count").textContent = String(packetCount);
                handleSensorValue(sensor, characteristic.value);
              } catch (error) {
                window.clearInterval(timer);
                readTimers.delete(timer);
                console.error(`Could not read ${sensor.name} over BLE.`, error);
                setStatus(`${sensor.name} read failed: ${error.message || error.name}`, "error");
              } finally {
                readInFlight = false;
              }
            }, sensor.readIntervalMs);
            readTimers.add(timer);
          } else {
            const required = sensor.mode === "read" ? "read" : "notify/indicate";
            throw new Error(`This profile requires ${required}; available properties: ${
              ["read", "notify", "indicate"].filter(property => characteristic.properties[property]).join(", ") || "none"
            }.`);
          }
          available.push(sensor);
        } catch (error) {
          unavailable.push(`${sensor.name}: ${error.message || error.name}`);
          console.error(`Could not configure sensor "${sensor.name}".`, error);
        }
      }
      if (available.length === 0) {
        throw new Error(unavailable.join(" · ") || "No configured sensor characteristics were available.");
      }
      activeSensors = available;
      connectionPhase.characteristics = true;
      connectionPhase.notifications = available.length > 0;
      rememberDevice(device);
      renderSensors();
      renderChartSensorOptions();
      renderLiveGraph();
      updateAnalytics();
      document.querySelector("#last-connection").textContent = formatTimestamp(Date.now());
      document.querySelector("#device-name").textContent = device.name || "Unnamed BLE device";
      document.querySelector("#device-alias").value = displayDeviceName(device);
      document.querySelector("#save-device-alias").disabled = false;
      document.querySelector("#firmware-version").textContent = "Not reported by this device";
      document.querySelector("#device-uptime").textContent = "Not reported by this device";
      document.querySelector("#signal-strength").textContent = "Not exposed by Web Bluetooth";
      updateConnectionSteps();
      const capabilityCount = knownCharacteristics.length;
      setStatus(unavailable.length
        ? `GATT connected · ${available.length}/${activeProfile.sensors.length} profile mappings ready; ${unavailable.length} unavailable.`
        : `GATT connected · ${capabilityCount} characteristic(s) discovered; waiting for valid telemetry.`,
      "connected");
      if (details.length && unavailable.length) setDiagnostics([...details, ...unavailable.map(message => `Profile mapping: ${message}`)]);
      await refreshAuthorizedDevices();
    } catch (error) {
      console.error("Bluetooth connection or GATT setup failed.", error);
      clearGattSubscriptions();
      if (device.gatt?.connected) device.gatt.disconnect();
      currentDevice = null;
      connectionPhase = { discovered: true, gatt: false, characteristics: false, notifications: false };
      activeSensors = [];
      sensorValues.clear();
      sensorStates.clear();
      renderSensors();
      updateConnectionUi();
      updateConnectionSteps();
      document.querySelector("#device-name").textContent = "Not connected";
      document.querySelector("#device-alias").value = "";
      document.querySelector("#save-device-alias").disabled = true;
      const message = `${error.name || "Bluetooth error"}: ${error.message || "Could not connect to this device."}`;
      setStatus(message, error.name === "NotFoundError" ? "" : "error");
    } finally {
      busy = false;
      updateConnectionUi();
    }
  }

  function onDisconnected() {
    clearGattSubscriptions();
    connectionPhase.gatt = false;
    connectionPhase.notifications = false;
    logging = false;
    experimentButton.textContent = "Start logging";
    document.querySelector("#experiment-title").textContent = "Session logging is off";
    activeSensors.forEach(sensor => sensorStates.set(sensor.characteristicUuid, "stale"));
    setStatus("Bluetooth disconnected · previous readings are stale.", "");
    document.querySelector("#reconnect-button").hidden = false;
    updateConnectionUi();
    updateConnectionSteps();
    renderLiveGraph();
  }

  function clearGattSubscriptions() {
    readTimers.forEach(timer => window.clearInterval(timer));
    readTimers.clear();
    flushDeviceRecords();
    characteristicListeners.forEach(({ characteristic, handler }) => {
      characteristic.removeEventListener("characteristicvaluechanged", handler);
    });
    characteristicListeners.clear();
  }

  function attachDisconnectHandler(device) {
    const previousHandler = disconnectHandlers.get(device);
    if (previousHandler) device.removeEventListener("gattserverdisconnected", previousHandler);
    const handler = () => {
      if (currentDevice !== device) return;
      onDisconnected();
    };
    disconnectHandlers.set(device, handler);
    device.addEventListener("gattserverdisconnected", handler);
  }

  async function requestConnection() {
    if (!window.isSecureContext) {
      setStatus("Bluetooth requires a secure HTTPS website.", "error");
      return;
    }
    if (!navigator.bluetooth) {
      setStatus("Web Bluetooth is unavailable. Try a supported Chrome or Edge browser.", "error");
      return;
    }
    if (!savedProfiles.some(profile => profile.id === activeProfile.id)) {
      setStatus("Save this BLE profile before connecting so its GATT service is included in browser permissions.", "error");
      document.querySelector("#profile-details").open = true;
      return;
    }
    if (busy) return;
    busy = true;
    updateConnectionUi();
    try {
      const device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [...new Set([
          ...savedProfiles.map(profile => profile.serviceUuid),
          "0000181a-0000-1000-8000-00805f9b34fb"
        ])]
      });
      attachDisconnectHandler(device);
      busy = false;
      await connectDevice(device);
    } catch (error) {
      console.error("Bluetooth device chooser failed.", error);
      const message = error.name === "NotFoundError"
        ? "No device selected. Bluetooth remains disconnected."
        : `${error.name || "Bluetooth error"}: ${error.message || "Device selection failed."}`;
      setStatus(message, error.name === "NotFoundError" ? "" : "error");
    } finally {
      busy = false;
      updateConnectionUi();
    }
  }

  function toggleConnection() {
    if (busy) return;
    if (isConnected()) {
      currentDevice.gatt.disconnect();
      return;
    }
    requestConnection();
  }

  function reconnectCurrentDevice() {
    if (busy) return;
    const device = currentDevice || authorizedDevices.find(item => item.id === readStoredJson(DEVICE_HISTORY_KEY, [])[0]?.id);
    if (!device) {
      setStatus("No browser-authorized device is available to reconnect. Use Connect device to choose it again.", "error");
      return;
    }
    attachDisconnectHandler(device);
    connectDevice(device);
  }

  function toggleLogging() {
    if (!isConnected() && !logging) {
      setStatus("Connect a device before starting telemetry logging.", "error");
      return;
    }
    logging = !logging;
    experimentButton.textContent = logging ? "Stop logging" : "Start logging";
    document.querySelector("#experiment-title").textContent = logging ? "Logging actual sensor data" : "Session logging is off";
    if (!logging) {
      flushDeviceRecords();
      document.querySelector("#row-count").textContent =
        `${deviceRecords.length} actual sensor sample${deviceRecords.length === 1 ? "" : "s"} stored on this device.`;
    } else {
      document.querySelector("#row-count").textContent = "Saving incoming sensor readings locally on this device.";
      setStatus("Logging started · only incoming BLE readings are saved.", "connected");
    }
    experimentButton.disabled = !isConnected() && !logging;
  }

  function handleSensorCardAction(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const card = button.closest(".sensor-card");
    const sensor = activeSensors.find(item => item.characteristicUuid === card?.dataset.sensorUuid);
    if (!sensor) return;
    if (button.dataset.action === "rename-sensor") {
      const currentName = getDisplayName(sensor);
      const nextName = window.prompt("Display name for this sensor:", currentName);
      if (nextName === null) return;
      const trimmed = nextName.trim();
      if (!trimmed) {
        setStatus("Sensor display name cannot be empty.", "error");
        return;
      }
      deviceLabels[sensor.characteristicUuid] = trimmed.slice(0, 40);
      if (writeStoredJson(SENSOR_LABELS_KEY, deviceLabels)) {
        updateSensorCard(sensor);
        renderChartSensorOptions();
        updateAnalytics();
      }
    }
  }

  function handleDeviceHistoryAction(event) {
    const forgetButton = event.target.closest("button[data-forget-device-id]");
    if (forgetButton) {
      forgetDevice(forgetButton.dataset.forgetDeviceId);
      return;
    }
    const renameButton = event.target.closest("button[data-rename-device-id]");
    if (renameButton) {
      const saved = readStoredJson(DEVICE_HISTORY_KEY, []);
      const entry = Array.isArray(saved) && saved.find(item => item?.id === renameButton.dataset.renameDeviceId);
      if (!entry) return;
      const name = window.prompt("Saved device name:", entry.name || "BLE device");
      if (name !== null) renameDevice(entry.id, name);
      return;
    }
    const button = event.target.closest("button[data-device-id]");
    if (!button) return;
    if (isConnected()) {
      setStatus("Disconnect the active BLE device before connecting a different saved device.", "error");
      return;
    }
    const device = authorizedDevices.find(item => item.id === button.dataset.deviceId);
    if (!device) {
      setStatus("This browser no longer has permission for that device. Connect it again to grant access.", "error");
      return;
    }
    const saved = readStoredJson(DEVICE_HISTORY_KEY, []);
    const entry = Array.isArray(saved) && saved.find(item => item?.id === device.id);
    const profile = entry?.profileId ? profileById(entry.profileId) : null;
    if (profile) activateProfile(profile);
    attachDisconnectHandler(device);
    connectDevice(device);
  }

  function bindEvents() {
    connectButton.addEventListener("click", toggleConnection);
    experimentButton.addEventListener("click", toggleLogging);
    exportButton.addEventListener("click", exportCsv);
    profileForm.addEventListener("submit", saveProfile);
    document.querySelector("#add-sensor-button").addEventListener("click", () => addProfileSensorRow({ type: "Custom", precision: 2 }));
    document.querySelector("#reset-profile-button").addEventListener("click", restoreDefaultProfile);
    document.querySelector("#profile-select").addEventListener("change", event => {
      const profile = profileById(event.target.value);
      if (profile) activateProfile(profile);
    });
    document.querySelector("#new-profile-button").addEventListener("click", createNewProfile);
    document.querySelector("#delete-profile-button").addEventListener("click", deleteActiveProfile);
    document.querySelector("#sig-profile-button").addEventListener("click", () => applyPreset(SIG_ENVIRONMENTAL_PROFILE));
    document.querySelector("#legacy-profile-button").addEventListener("click", () => applyPreset(LEGACY_PROFILE));
    profileSensors.addEventListener("click", event => {
      const button = event.target.closest('[data-action="remove-sensor"]');
      if (button) button.closest(".profile-sensor-row").remove();
    });
    document.querySelector("#sensor-grid").addEventListener("click", handleSensorCardAction);
    document.querySelector("#chart-sensor").addEventListener("change", updateAnalytics);
    document.querySelector("#chart-sensor").addEventListener("change", renderLiveGraph);
    document.querySelectorAll(".range-button").forEach(button => button.addEventListener("click", () => {
      selectedRange = Number(button.dataset.range);
      document.querySelectorAll(".range-button").forEach(item => item.classList.toggle("is-active", item === button));
      updateAnalytics();
    }));
    deviceHistory.addEventListener("click", handleDeviceHistoryAction);
    document.querySelector("#reconnect-button").addEventListener("click", reconnectCurrentDevice);
    document.querySelector("#history-device-select").addEventListener("change", event => {
      if (isConnected()) return;
      const saved = readStoredJson(DEVICE_HISTORY_KEY, []);
      const entry = Array.isArray(saved) && saved.find(item => item?.id === event.target.value);
      if (!entry) return;
      loadDeviceRecords(entry.id);
      const profile = profileById(entry.profileId);
      if (profile) activateProfile(profile);
      else {
        updateAnalytics();
        renderLiveGraph();
      }
    });
    document.querySelector("#save-device-alias").addEventListener("click", () => {
      if (!currentDevice?.id) return;
      renameDevice(currentDevice.id, document.querySelector("#device-alias").value);
    });
    document.querySelector("#live-range-switch").addEventListener("click", event => {
      const button = event.target.closest("button[data-range]");
      if (!button) return;
      liveRange = Number(button.dataset.range);
      document.querySelectorAll(".live-range-button").forEach(item => item.classList.toggle("is-active", item === button));
      renderLiveGraph();
    });
    document.querySelector("#pause-graph-button").addEventListener("click", event => {
      graphPaused = !graphPaused;
      event.currentTarget.textContent = graphPaused ? "Resume graph" : "Pause graph";
      if (graphPaused) document.querySelector("#live-graph-status").textContent = "Graph paused · telemetry collection continues";
      else renderLiveGraph();
    });
    document.querySelector("#clear-graph-button").addEventListener("click", () => {
      graphClearedAt = Date.now();
      renderLiveGraph();
    });
    menuToggle.addEventListener("click", () => {
      const expanded = menuToggle.getAttribute("aria-expanded") === "true";
      menuToggle.setAttribute("aria-expanded", String(!expanded));
      primaryNav.classList.toggle("is-open", !expanded);
    });
    primaryNav.addEventListener("click", event => {
      if (event.target.closest("a")) {
        menuToggle.setAttribute("aria-expanded", "false");
        primaryNav.classList.remove("is-open");
      }
    });
    window.addEventListener("resize", () => {
      updateAnalytics();
      renderLiveGraph();
    });
    window.addEventListener("beforeinstallprompt", event => {
      event.preventDefault();
      installPrompt = event;
      installButton.hidden = false;
    });
    window.addEventListener("appinstalled", () => {
      installPrompt = null;
      installButton.hidden = true;
      setStatus("NEXORA is installed on this device.", isConnected() ? "connected" : "");
    });
    installButton.addEventListener("click", async () => {
      if (!installPrompt) return;
      try {
        await installPrompt.prompt();
        await installPrompt.userChoice;
        installPrompt = null;
        installButton.hidden = true;
      } catch (error) {
        console.error("PWA installation prompt failed.", error);
        setStatus(`Could not start installation: ${error.message || error.name}`, "error");
      }
    });
    window.addEventListener("offline", () => setStatus("Offline · cached interface is available; live Bluetooth needs this page open.", isConnected() ? "connected" : ""));
    window.addEventListener("online", () => {
      if (!isConnected()) setStatus("Online · ready to connect");
    });
  }

  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch (error) {
      console.error("Could not register the NEXORA offline app shell.", error);
      setStatus(`Offline app shell could not be installed: ${error.message || error.name}`, "error");
    }
  }

  function initialize() {
    savedProfiles = loadProfiles();
    const selectedProfileId = readStoredJson(ACTIVE_PROFILE_KEY, null);
    const recentDevices = readStoredJson(DEVICE_HISTORY_KEY, []);
    const recentDevice = Array.isArray(recentDevices) ? recentDevices[0] : null;
    activeProfile = profileById(recentDevice?.profileId) || profileById(selectedProfileId) || savedProfiles[0];
    renderProfileSelector();
    renderProfileForm();
    renderChartSensorOptions();
    renderDeviceHistory();
    if (recentDevice?.id) loadDeviceRecords(recentDevice.id);
    setCapabilityMessage();
    bindEvents();
    updateConnectionUi();
    updateAnalytics();
    renderLiveGraph();
    window.setInterval(updateSensorHealth, 1000);
    refreshAuthorizedDevices();
    registerServiceWorker();
  }

  initialize();
})();
