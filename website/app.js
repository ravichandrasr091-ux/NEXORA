(() => {
  "use strict";

  const DEFAULT_PROFILE = {
    serviceUuid: "7b7e0001-7d7a-4f4e-9b8d-2f8c4a6d1000",
    sensors: [
      { name: "Temperature", type: "Temperature", characteristicUuid: "7b7e0002-7d7a-4f4e-9b8d-2f8c4a6d1000", unit: "°C", precision: 2 },
      { name: "Relative humidity", type: "Humidity", characteristicUuid: "7b7e0003-7d7a-4f4e-9b8d-2f8c4a6d1000", unit: "% RH", precision: 2 }
    ]
  };
  const PROFILE_KEY = "nexora.gatt-profile.v1";
  const DEVICE_HISTORY_KEY = "nexora.device-history.v1";
  const SENSOR_LABELS_KEY = "nexora.sensor-labels.v1";
  const MAX_SENSORS = 16;
  const MAX_HISTORY_PER_DEVICE = 5000;
  const STALE_AFTER_MS = 8000;
  const encoder = new TextDecoder("utf-8");
  const disconnectHandlers = new WeakMap();
  const statusText = document.querySelector("#status");
  const statusDot = document.querySelector("#status-dot");
  const connectButton = document.querySelector("#connect-button");
  const experimentButton = document.querySelector("#experiment-button");
  const exportButton = document.querySelector("#export-button");
  const chart = document.querySelector("#chart");
  const chartContext = chart.getContext("2d");
  const profileForm = document.querySelector("#profile-form");
  const profileSensors = document.querySelector("#profile-sensors");
  const deviceHistory = document.querySelector("#device-history");
  const menuToggle = document.querySelector("#menu-toggle");
  const primaryNav = document.querySelector("#primary-nav");
  const installButton = document.querySelector("#install-button");
  const activeProfile = loadProfile();
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
  let currentDevice = null;
  let activeSensors = [];
  let busy = false;
  let logging = false;
  let packetCount = 0;
  let lastTelemetryAt = null;
  let installPrompt = null;
  let selectedRange = 60 * 60 * 1000;
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
    return String(value || "").trim().toLowerCase();
  }

  function isValidUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }

  function loadProfile() {
    const saved = readStoredJson(PROFILE_KEY, null);
    if (!saved) return structuredClone(DEFAULT_PROFILE);
    const validSensors = Boolean(saved && Array.isArray(saved.sensors) &&
      saved.sensors.length > 0 &&
      saved.sensors.length <= MAX_SENSORS &&
      saved.sensors.every(sensor =>
        sensor &&
        typeof sensor.name === "string" && sensor.name.trim() &&
        typeof sensor.type === "string" && sensor.type.trim() &&
        typeof sensor.unit === "string" &&
        isValidUuid(sensor.characteristicUuid) &&
        Number.isInteger(sensor.precision) && sensor.precision >= 0 && sensor.precision <= 6));
    const distinctCharacteristics = validSensors &&
      new Set(saved.sensors.map(sensor => normalizedUuid(sensor.characteristicUuid))).size === saved.sensors.length;
    if (!saved || typeof saved.serviceUuid !== "string" || !isValidUuid(saved.serviceUuid) ||
        !validSensors || !distinctCharacteristics) {
      console.error("Saved NEXORA GATT profile is invalid or incomplete.");
      setStatus("The saved GATT profile is invalid. Restore the default profile or configure it again.", "error");
      return structuredClone(DEFAULT_PROFILE);
    }
    return {
      serviceUuid: normalizedUuid(saved.serviceUuid),
      sensors: saved.sensors.map(sensor => ({
        ...sensor,
        characteristicUuid: normalizedUuid(sensor.characteristicUuid)
      }))
    };
  }

  function setStatus(message, state = "") {
    statusText.textContent = message;
    statusDot.classList.toggle("connected", state === "connected");
    statusDot.classList.toggle("error", state === "error");
  }

  function isConnected() {
    return Boolean(currentDevice?.gatt?.connected);
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
    updateSensorHealth();
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
    input.value = value || "";
    input.required = Boolean(options.required);
    input.autocomplete = "off";
    if (options.maxLength) input.maxLength = options.maxLength;
    if (options.spellcheck === false) input.spellcheck = false;
    label.append(caption, input);
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
      buildField("Characteristic UUID", "sensor-uuid-input", sensor.characteristicUuid || "", { required: true, spellcheck: false, maxLength: 36 })
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
    document.querySelector("#service-uuid").value = activeProfile.serviceUuid;
    profileSensors.replaceChildren();
    activeProfile.sensors.forEach(addProfileSensorRow);
    document.querySelector("#service-value").textContent = activeProfile.serviceUuid;
  }

  function collectProfileFromForm() {
    const serviceUuid = normalizedUuid(document.querySelector("#service-uuid").value);
    if (!isValidUuid(serviceUuid)) throw new Error("Enter a valid 128-bit service UUID.");
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
      return { name, type, unit, precision, characteristicUuid };
    });
    const characteristicUuids = sensors.map(sensor => sensor.characteristicUuid);
    if (new Set(characteristicUuids).size !== characteristicUuids.length) {
      throw new Error("Each sensor must use a different characteristic UUID.");
    }
    return { serviceUuid, sensors };
  }

  function saveProfile(event) {
    event.preventDefault();
    let nextProfile;
    try {
      nextProfile = collectProfileFromForm();
    } catch (error) {
      setStatus(error.message, "error");
      return;
    }
    if (!writeStoredJson(PROFILE_KEY, nextProfile)) return;
    if (isConnected()) currentDevice.gatt.disconnect();
    activeProfile.serviceUuid = nextProfile.serviceUuid;
    activeProfile.sensors = nextProfile.sensors;
    activeSensors = [];
    sensorValues.clear();
    sensorStates.clear();
    renderProfileForm();
    renderSensors();
    renderChartSensorOptions();
    updateAnalytics();
    setStatus("GATT profile saved on this browser.");
  }

  function restoreDefaultProfile() {
    if (!writeStoredJson(PROFILE_KEY, DEFAULT_PROFILE)) return;
    if (isConnected()) currentDevice.gatt.disconnect();
    activeProfile.serviceUuid = DEFAULT_PROFILE.serviceUuid;
    activeProfile.sensors = structuredClone(DEFAULT_PROFILE.sensors);
    renderProfileForm();
    activeSensors = [];
    sensorValues.clear();
    sensorStates.clear();
    renderSensors();
    renderChartSensorOptions();
    updateAnalytics();
    setStatus("Default NEXORA-compatible ESP32 profile restored.");
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
    } else if (reading && Date.now() - reading.timestamp <= STALE_AFTER_MS && isConnected()) {
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
    const fresh = [...sensorValues.values()].some(value => Date.now() - value.timestamp <= STALE_AFTER_MS);
    if (connected && fresh) setStatus("BLE connected · telemetry is live", "connected");
    else if (connected && lastTelemetryAt) setStatus("BLE connected · telemetry is stale", "connected");
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
    if (!dataView || dataView.byteLength === 0) {
      handleInvalidValue(sensor, "empty BLE payload received.");
      return;
    }
    const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
    const raw = encoder.decode(bytes).trim();
    if (!raw || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) {
      handleInvalidValue(sensor, "expected a UTF-8 numeric reading.");
      return;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      handleInvalidValue(sensor, "reading is outside the supported numeric range.");
      return;
    }
    const timestamp = Date.now();
    const reading = {
      timestamp: new Date(timestamp).toISOString(),
      characteristicUuid: sensor.characteristicUuid,
      sensorName: getDisplayName(sensor),
      sensorType: sensor.type,
      value,
      unit: sensor.unit
    };
    sensorValues.set(sensor.characteristicUuid, { value, timestamp });
    sensorStates.set(sensor.characteristicUuid, "valid");
    lastTelemetryAt = timestamp;
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
    updateAnalytics();
  }

  function persistDeviceRecords() {
    if (!currentDevice?.id || persistTimer !== null) return;
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
    if (currentDevice?.id) writeStoredJson(historyStorageKey(currentDevice.id), deviceRecords);
  }

  function historyStorageKey(deviceId) {
    return `nexora.readings.v1.${encodeURIComponent(deviceId)}`;
  }

  function loadDeviceRecords(deviceId) {
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
      Number.isFinite(record.value) && typeof record.unit === "string"
    ).slice(-MAX_HISTORY_PER_DEVICE);
    deviceRecords.splice(0, deviceRecords.length, ...validRecords);
    document.querySelector("#row-count").textContent =
      `${deviceRecords.length} saved sensor sample${deviceRecords.length === 1 ? "" : "s"} for this device.`;
    exportButton.disabled = deviceRecords.length === 0;
  }

  function allAvailableRecords() {
    const records = [...deviceRecords, ...sessionRecords];
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
    const label = selectedRange === 3600000 ? "1 hour" :
      selectedRange === 86400000 ? "24 hours" :
        selectedRange === 604800000 ? "7 days" : "30 days";
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
    const rows = [
      ["Timestamp", "Device", "Sensor", "Type", "Characteristic_UUID", "Value", "Unit"],
      ...records.map(record => [
        record.timestamp,
        currentDevice?.name || "ESP32 device",
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
    const next = [{
      id: device.id,
      name: device.name || "ESP32 device",
      serviceUuid: activeProfile.serviceUuid,
      lastConnected: new Date().toISOString()
    }, ...saved.filter(item => item && item.id !== device.id)].slice(0, 10);
    writeStoredJson(DEVICE_HISTORY_KEY, next);
    renderDeviceHistory(next);
  }

  function renderDeviceHistory(saved = readStoredJson(DEVICE_HISTORY_KEY, [])) {
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
      last.textContent = `Last connected ${formatTimestamp(Date.parse(item.lastConnected))}`;
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
      deviceHistory.append(row);
    });
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

  async function connectDevice(device) {
    if (busy) return;
    flushDeviceRecords();
    busy = true;
    updateConnectionUi();
    setStatus(`Connecting to ${device.name || "ESP32 device"}…`);
    currentDevice = device;
    activeSensors = [];
    sensorValues.clear();
    sensorStates.clear();
    if (logging) {
      logging = false;
      experimentButton.textContent = "Start logging";
      document.querySelector("#experiment-title").textContent = "Session logging is off";
    }
    deviceRecords.splice(0);
    sessionRecords.splice(0);
    exportButton.disabled = true;
    document.querySelector("#row-count").textContent = "Waiting for telemetry from this device.";
    packetCount = 0;
    lastTelemetryAt = null;
    try {
      if (!device.gatt) throw new Error("This Bluetooth device does not expose a GATT server.");
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(activeProfile.serviceUuid);
      const available = [];
      const unavailable = [];
      for (const sensor of activeProfile.sensors) {
        try {
          const characteristic = await service.getCharacteristic(sensor.characteristicUuid);
          sensor.characteristic = characteristic;
          const supportsNotifications = characteristic.properties.notify || characteristic.properties.indicate;
          if (supportsNotifications) {
            const handler = event => {
              packetCount += 1;
              handleSensorValue(sensor, event.target.value);
            };
            const previous = characteristicListeners.get(sensor.characteristicUuid);
            if (previous) previous.characteristic.removeEventListener("characteristicvaluechanged", previous.handler);
            characteristic.addEventListener("characteristicvaluechanged", handler);
            characteristicListeners.set(sensor.characteristicUuid, { characteristic, handler });
            await characteristic.startNotifications();
          } else if (characteristic.properties.read) {
            await characteristic.readValue();
            packetCount += 1;
            handleSensorValue(sensor, characteristic.value);
            const timer = window.setInterval(async () => {
              if (!isConnected()) return;
              try {
                await characteristic.readValue();
                packetCount += 1;
                handleSensorValue(sensor, characteristic.value);
              } catch (error) {
                window.clearInterval(timer);
                readTimers.delete(timer);
                console.error(`Could not read ${sensor.name} over BLE.`, error);
                setStatus(`${sensor.name} read failed: ${error.message || error.name}`, "error");
              }
            }, 2000);
            readTimers.add(timer);
          } else {
            throw new Error("Characteristic supports neither notifications nor reads.");
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
      sensorValues.clear();
      sensorStates.clear();
      sessionRecords.splice(0);
      loadDeviceRecords(device.id);
      rememberDevice(device);
      renderSensors();
      renderChartSensorOptions();
      updateAnalytics();
      document.querySelector("#last-connection").textContent = formatTimestamp(Date.now());
      document.querySelector("#firmware-version").textContent = "Not reported by this device";
      document.querySelector("#device-uptime").textContent = "Not reported by this device";
      document.querySelector("#signal-strength").textContent = "Not exposed by Web Bluetooth";
      setStatus(unavailable.length
        ? `Connected · ${available.length} sensor(s) ready; ${unavailable.length} unavailable. ${unavailable.join(" · ")}`
        : `Connected to ${device.name || "ESP32 device"} · waiting for telemetry`,
      "connected");
      await refreshAuthorizedDevices();
    } catch (error) {
      console.error("Bluetooth connection or GATT setup failed.", error);
      clearGattSubscriptions();
      if (device.gatt?.connected) device.gatt.disconnect();
      currentDevice = null;
      activeSensors = [];
      sensorValues.clear();
      sensorStates.clear();
      renderSensors();
      updateConnectionUi();
      const message = error.name === "NotFoundError"
        ? "No device selected. Check that the ESP32 is powered and advertising the configured service."
        : `${error.name || "Bluetooth error"}: ${error.message || "Could not connect to this device."}`;
      setStatus(message, error.name === "NotFoundError" ? "" : "error");
    } finally {
      busy = false;
      updateConnectionUi();
    }
  }

  function onDisconnected() {
    clearGattSubscriptions();
    activeSensors.forEach(sensor => sensorStates.set(sensor.characteristicUuid, "stale"));
    setStatus("Bluetooth disconnected · previous readings are stale.", "");
    updateConnectionUi();
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
    if (busy) return;
    busy = true;
    updateConnectionUi();
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [activeProfile.serviceUuid] }]
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
    const button = event.target.closest("button[data-device-id]");
    if (!button) return;
    const device = authorizedDevices.find(item => item.id === button.dataset.deviceId);
    if (!device) {
      setStatus("This browser no longer has permission for that device. Connect it again to grant access.", "error");
      return;
    }
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
    profileSensors.addEventListener("click", event => {
      const button = event.target.closest('[data-action="remove-sensor"]');
      if (button) button.closest(".profile-sensor-row").remove();
    });
    document.querySelector("#sensor-grid").addEventListener("click", handleSensorCardAction);
    document.querySelector("#chart-sensor").addEventListener("change", updateAnalytics);
    document.querySelectorAll(".range-button").forEach(button => button.addEventListener("click", () => {
      selectedRange = Number(button.dataset.range);
      document.querySelectorAll(".range-button").forEach(item => item.classList.toggle("is-active", item === button));
      updateAnalytics();
    }));
    deviceHistory.addEventListener("click", handleDeviceHistoryAction);
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
    window.addEventListener("resize", updateAnalytics);
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
    renderProfileForm();
    renderChartSensorOptions();
    renderDeviceHistory();
    setCapabilityMessage();
    bindEvents();
    updateConnectionUi();
    updateAnalytics();
    window.setInterval(updateSensorHealth, 1000);
    refreshAuthorizedDevices();
    registerServiceWorker();
  }

  initialize();
})();
