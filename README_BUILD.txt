NEXORA — UNIVERSAL BLE MONITORING

PROJECT AND ARCHITECTURE
- The website is a static, framework-free HTML/CSS/JavaScript PWA. `website/app.js` owns UI state and GATT lifecycle; `website/ble-protocol.js` contains pure UUID and payload decoding helpers with Node tests.
- No backend, MQTT broker, or cloud telemetry service is configured. The website cannot receive ESP32 Wi-Fi telemetry; profiles, device labels, and logged readings remain in this browser's local storage.
- The Android application is a separate native Kotlin application. Its Classic SPP and BLE transports, local settings, and sensor history are independent of the website.
- The website and PWA have no native Bluetooth Classic SPP access.

ANDROID APPLICATIONS
- Android 2.0 remains available as the legacy app at `website/downloads/nexora-android-v2.0.apk`; it is not overwritten or upgraded by Smart Chamber 2.1.
- Smart Chamber 2.6 is an update to the existing preview application, retaining application ID `com.nexora.smartchamber` and incrementing to version code 6. It is not a new app package. Android 2.0 uses a different application ID and signing identity and is not updated by this APK.
- The V2.6 APK retains the V2.5 debug signing certificate for upgrade compatibility. It is debuggable, not a production release. A private, backed-up release keystore is required before switching to production signing or publishing through an app store.
- The V2.0 APK uses application ID `com.muted.ragiincubator`, version code 2, and its original debug signing certificate. Its settings and sensor history remain local to that app.
- V2.6 provides Home, Monitor, History, Analytics, Settings, and an online update checker/downloader using GitHub Pages. Updates are checksum- and package/version-validated before Android's installer is opened.
- Target selection is limited to 1–60°C in 0.5°C steps for the newer controller firmware, which reports its 65°C software over-temperature lockout. The target control remains in Celsius; the Celsius/Fahrenheit setting changes sensor displays only. The Android app supports both the legacy `NEXORA/1` controller and the newer target/status/acknowledgement characteristic layout. It displays reported heater and safety states and disables Apply for an explicit sensor error or safety lockout.
- The updater was added in V2.6. V2.5 users need to install V2.6 once from the website; subsequent versions can be downloaded from Settings and installed with Android's confirmation.
- The checked-in ESP32 sketch still reports `HEATER_UNAVAILABLE` and rejects every setpoint. It does not implement the newer target/status/acknowledgement characteristics; real target control therefore requires firmware that implements and validates that contract. No physical BLE/control test is claimed.
- Smart Chamber 2.6 runs as a foreground-only BLE client and supports the existing custom sensor UUIDs and SIG Environmental Sensing (`181A`, `2A6E`, `2A6F`). BLE scanning requires a user action and Android Bluetooth permissions. Reconnection is attempted while the app is foregrounded; Android background execution is not claimed.
- Live telemetry is marked stale after 15 seconds without a valid sensor message. Only real BLE readings are shown. Temperature is stored in Celsius and converted for Fahrenheit display.
- Room history retains the most recent 30 days. To limit database growth, records are sampled at most once per sensor kind per minute, while the live display continues to update from BLE. CSV export uses Android's document picker.
- The coordinated protocol and current safe-disabled ESP32 behavior are documented in `SMART_CHAMBER_BLE_PROTOCOL.md`. Existing temperature/humidity characteristics remain compatible. The ESP32 control service reports heater unavailable and rejects all setpoint writes.
- The ESP32 sketch does not select or drive a chamber-heater GPIO. Heater control remains disabled pending verified driver logic, electrical ratings, chamber limits, sensor placement, and independent over-temperature protection. No offline ESP32 history is advertised.
- Build with JDK 17 or newer, Android SDK platform 35, and Gradle 8.9 or newer: `gradle --no-daemon assembleDebug`. The APK is written to `app/build/outputs/apk/debug/app-debug.apk`. This debug APK is debuggable and is not a production-signed release.
- Physical BLE and firmware tests have not been performed on the target phone and chamber. Verify the ESP32-WROOM-32/SHT4x connection before relying on sensor telemetry.

WEB BLUETOOTH LIMITS AND CONNECTION
- Open the GitHub Pages site over HTTPS in a BLE-capable Chrome/Edge browser. Click Connect device and choose the ESP32 advertised as `NEXORA-SENSOR`; `requestDevice()` requires this user gesture. BLE is local and does not require internet or Wi-Fi, but the page must remain open. GitHub Pages is static hosting, not an ESP32 Wi-Fi/API endpoint.
- Web Bluetooth does not provide an unrestricted background scan list. NEXORA filters for the selected sensor service or `NEXORA` device name and requests access to saved sensor profiles, Bluetooth SIG Environmental Sensing, and the Smart Chamber control service.
- A selected device is not called connected until `device.gatt.connect()` succeeds. The diagnostics show discovery, GATT connection, mapped characteristics, notification/read readiness, valid telemetry, and freshness separately.
- Sensor data is received through GATT reads or notification/indication subscriptions. The website discovers the versioned Smart Chamber control service, reads controller readiness, and only enables target writes when the ESP32 reports `HEATER_READY` and `SENSOR_OK`. The current firmware reports `HEATER_UNAVAILABLE`, so target controls remain draft-only and every firmware command is rejected.
- Keep the page in the foreground while monitoring. Browser support and BLE permissions vary by OS; Web Bluetooth is not available in Firefox or Safari in their standard configurations, and is not supported from an insecure network origin.

SAVED PROFILES AND TELEMETRY FORMATS
- Sensor Configuration has local saved profiles, a Bluetooth SIG Environmental Sensing preset, and the original ESP32 preset. The existing ESP32 UUID mapping is preserved.
- Service and characteristic identifiers accept 16-bit UUIDs (for example `181A` or `0x2A6E`), SIG aliases such as `environmental_sensing`, or full 128-bit UUIDs.
- Each sensor mapping configures its label, type, unit, decimals, payload format, scale, offset, optional numeric min/max, access mode, byte order, and read interval.
- Formats: UTF-8 numeric text; JSON with a dot-separated numeric field path (for example `sensors.temperature.value`); simple delimited CSV with a zero-based stored column (the UI displays 1-based columns); Bluetooth SIG temperature and humidity; and little-/big-endian signed/unsigned 16-/32-bit integers or 32-/64-bit IEEE floats.
- Bluetooth SIG Environmental Sensing uses service `0x181A`, temperature `0x2A6E` and humidity `0x2A6F`. Temperature is signed int16 and humidity unsigned uint16; both decode little-endian in units of 0.01. The preset polls readable characteristics every 2 seconds. Change each mapping to notification mode only if that characteristic advertises notify/indicate.
- `scale` and `offset` apply after format decoding: `displayed = decoded × scale + offset`. Optional bounds reject values outside a user-configured physical range. Confirm the units, byte order, mappings, and scaling against the actual firmware documentation before relying on values.
- A notification mapping requires notify or indicate. A periodic-read mapping requires read. The selected mode is not silently replaced by the other mode.
- JSON and CSV payloads must be valid UTF-8. CSV handling is intentionally a simple delimiter/column mapping, not a quoted multi-line CSV parser. Device-provided timestamps are not inferred; the browser records receive timestamps.

LIVE GRAPH, HISTORY, AND DEVICE MANAGEMENT
- Sensor cards appear only for configured characteristics found on the connected device. The live graph plots actual received temperature and humidity samples on separate scales, with other profile types plotted when those standard types are absent.
- Live graph ranges: 30 seconds, 1 minute, 5 minutes, 15 minutes, and 1 hour. The graph advances on a one-second timer and appends actual incoming readings; plotted curves are visual smoothing only and do not alter recorded values. Pause affects drawing only; BLE reception continues. Clear graph hides older points in the current page view without deleting the saved CSV history.
- Historical graph ranges: 1 hour, 6 hours, 12 hours, 24 hours, 7 days, and 30 days. Historical data is available only if real readings were logged in this browser.
- No graph points are synthesized or interpolated. Long gaps are drawn as breaks. The 24-hour view only contains prior samples if logging was enabled and those real readings were stored.
- Start logging to persist received readings locally; up to 5,000 samples per device are retained. The currently active device's history can be exported as CSV. Clearing browser data removes these records.
- Saved BLE permission and profile details are local to the same browser profile. Reconnect is offered only when the browser still grants permission. Forgetting a saved device leaves its local reading history in place.

EXISTING ESP32 FIRMWARE EXAMPLE
- `ESP32_BLE_SHT4X.ino` reads one Adafruit SHT4x sensor over I2C (SDA GPIO26, SCL GPIO27). It exposes the original NEXORA custom service (UTF-8 numeric notifications), Bluetooth SIG Environmental Sensing service (two-byte little-endian notifications), and versioned Smart Chamber control service. Android scanning filters for the advertised NEXORA sensor service; Web Bluetooth offers the matching service or the `NEXORA` device name and requests access to sensor and control UUIDs.
- Arduino IDE: install Espressif ESP32 board support and the Adafruit SHT4x library/dependencies. Wire the module per its datasheet: VIN to a compatible 3V3 supply, GND to GND, SDA to GPIO26, and SCL to GPIO27. Select the actual ESP32 board/port and upload the `.ino`.
- Existing custom UUIDs: service `7b7e0001-7d7a-4f4e-9b8d-2f8c4a6d1000`, temperature `7b7e0002-7d7a-4f4e-9b8d-2f8c4a6d1000`, humidity `7b7e0003-7d7a-4f4e-9b8d-2f8c4a6d1000`.
- SIG UUIDs: service `181A`, temperature `2A6E`, humidity `2A6F`. The firmware obtains both values from the same SHT4x reading, serializes SIG values as signed/unsigned centi-units, and notifies only while a BLE client is connected.
- This is a working source example, not a claim of physical verification. The project still implements only the SHT4x sensor; additional sensor drivers and different ESP32 GATT layouts must be implemented/configured by the device owner.

TESTING
- Protocol unit tests: from the project root run `node --test website/ble-protocol.test.js`.
- Syntax checks: `node --check website/ble-protocol.js`, `node --check website/app.js`, and `node --check website/sw.js`.
- No-device test: open the site, click Connect, and cancel the chooser. It must remain disconnected without showing readings.
- Device/GATT tests require a compatible physical BLE sensor: select it; confirm GATT status, discovered UUID/property diagnostics, chosen read/notify readiness, and valid live telemetry separately.
- Verify temperature/humidity byte decoding with the decoder tests; then compare actual sensor readings to a trusted local instrument. Pause/resume, clear graph, range selection, logging, CSV export, disconnect/stale state, and reconnect can be exercised on hardware.
- Test browser permission revocation and absent service/characteristic mappings to confirm clear diagnostics. Browser automation cannot prove physical BLE radio behavior.
- Android Chrome test for the website: install/open Chrome on a BLE-capable Android phone, open the HTTPS URL, grant Bluetooth/Nearby Devices permissions when prompted, then tap Connect and choose `NEXORA-SENSOR`. Keep the tab/PWA open.
- Windows test: use current Chrome or Edge on a BLE-capable Windows computer, open the HTTPS URL, enable Bluetooth in Windows, tap Connect, and select the BLE device. Browser support depends on OS drivers and permissions.
- No physical ESP32, sensor, Android handset, or Windows BLE hardware verification is claimed until these steps have been performed on the user's actual devices.

BUILD AND DEPLOY
- GitHub Actions on pushes to `main` tests the website and update catalog, then deploys the static website and all APKs in `website/downloads`.
- Website telemetry and target requests use direct browser BLE. Target apply remains locked by the current firmware's `HEATER_UNAVAILABLE` status. Wi-Fi forwarding requires a separately provisioned HTTPS API or MQTT-over-TLS backend, device identity/authentication, and private configuration; none is currently present.
- Android 2.0 uses certificate SHA-256 `c25c4d71123b7de2e7de0bb97800bd662800c0c5a570b82efadbe34401b3ee90`. Android 3.x builds use different package identities and/or signing keys; they are not offered as updates.
- Website: https://ravichandrasr091-ux.github.io/NEXORA/
- Android 2.0 APK: https://ravichandrasr091-ux.github.io/NEXORA/downloads/nexora-android-v2.0.apk
- Smart Chamber 2.3 preview APK: https://ravichandrasr091-ux.github.io/NEXORA/downloads/nexora-smart-chamber-v2.3.apk
- Smart Chamber 2.4 preview APK: https://ravichandrasr091-ux.github.io/NEXORA/downloads/nexora-smart-chamber-v2.4.apk
- Smart Chamber 2.5 update APK: https://ravichandrasr091-ux.github.io/NEXORA/downloads/nexora-smart-chamber-v2.5.apk
- Smart Chamber 2.6 update APK: https://ravichandrasr091-ux.github.io/NEXORA/downloads/nexora-smart-chamber-v2.6.apk
- Smart Chamber 2.2 preview APK: https://ravichandrasr091-ux.github.io/NEXORA/downloads/nexora-smart-chamber-v2.2.apk
- Smart Chamber 2.1 previous preview APK: https://ravichandrasr091-ux.github.io/NEXORA/downloads/nexora-smart-chamber-v2.1.apk
- A debug APK is for testing and is not a Play Store release.
