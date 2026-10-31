NEXORA — UNIVERSAL BLE MONITORING

PROJECT AND ARCHITECTURE
- The website is a static, framework-free HTML/CSS/JavaScript PWA. `website/app.js` owns UI state and GATT lifecycle; `website/ble-protocol.js` contains pure UUID and payload decoding helpers with Node tests.
- No backend or cloud telemetry service is used. Profiles, device labels, and logged readings remain in this browser's local storage.
- The Android application is a separate native Kotlin application. Its Classic SPP and BLE transports, local settings, and sensor history are independent of the website.
- The website and PWA have no native Bluetooth Classic SPP access.

ANDROID APPLICATION
- Current app version: 3.0 (version code 3).
- Native Android destinations: Home, Devices, Analytics, and Settings. Device identity, BLE UUID profile, preferences, connection events, and up to 5,000 sensor samples are stored locally on the phone.
- Bluetooth Classic uses Android RFCOMM with the standard SPP UUID `00001101-0000-1000-8000-00805F9B34FB`. Pair the ESP32 once in Android Bluetooth Settings, then select its paired entry once in NEXORA. With automatic reconnect enabled, the saved address is retried at launch/foreground and after brief connection failures (up to three retries per failure cycle).
- Classic telemetry is parsed as independent UTF-8 lines such as `Temperature: 28.45 C`, `Humidity: 64.25 % RH`, and optionally `VOC raw: 12345`. Connection is not reported until the RFCOMM socket connects. Bluetooth Classic firmware must actually implement SPP and send these readings.
- Native BLE scans only after the user taps Scan. It supports the SIG Environmental Sensing service `181A` with temperature `2A6E` and humidity `2A6F`, plus the existing custom UUID profile. SIG temperature is signed little-endian int16 and humidity is unsigned little-endian uint16, both in hundredths. Read-only characteristics are polled every two seconds; notify/indicate characteristics are subscribed to after CCCD confirmation.
- Settings can configure the custom BLE service, temperature, humidity, and optional VOC raw characteristic UUIDs. Custom text values are parsed as numeric UTF-8; SIG values are decoded as binary. VOC is shown only when a configured characteristic or SPP line provides a valid raw signal. A raw SGP40 signal is not a VOC concentration or VOC Index.
- The existing `ESP32_BLE_SHT4X.ino` example currently exposes BLE only and reads an SHT4x. It does not implement Bluetooth Classic SPP or an SGP40 driver/characteristic. Thus Classic monitoring and raw VOC require compatible firmware; the Android app does not simulate those values.
- Android monitoring remains active only while the app process is running. No foreground service or continuous background Bluetooth connection is claimed. A real valid measurement is required for the receiving-data state; old readings are marked stale after 15 seconds.
- CSV export uses Android's document picker. Temperature is stored in Celsius and converted only for display/export when Fahrenheit is selected. Measurements are not sent to a cloud service.
- Build with JDK 17, Android SDK platform 35, and Gradle 8.9: `gradle --no-daemon assembleDebug`. The debug APK is written to `app/build/outputs/apk/debug/app-debug.apk`. The project has no release keystore configuration; debug output is not a Play Store release.
- Physical Bluetooth/ESP32 tests have not been performed in this workspace. Test Classic SPP and BLE on the target Android phone and compatible firmware before relying on device compatibility.

WEB BLUETOOTH LIMITS AND CONNECTION
- Open the GitHub Pages site over HTTPS in a BLE-capable Chrome/Edge browser. Click Connect device to open the browser's system chooser. `requestDevice()` requires this user gesture.
- Web Bluetooth does not provide an unrestricted background scan list. NEXORA uses `acceptAllDevices` and requests access only to services in saved profiles. It lists services and characteristics available through the resulting GATT permission; devices may hide other services.
- A selected device is not called connected until `device.gatt.connect()` succeeds. The diagnostics show discovery, GATT connection, mapped characteristics, notification/read readiness, valid telemetry, and freshness separately.
- Read-only data is received through GATT reads or notification/indication subscriptions. There are no control writes. Firmware version, uptime, and BLE RSSI are shown as unavailable unless a future firmware/protocol explicitly provides them.
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
- Live graph ranges: 1 minute, 5 minutes, 30 minutes, 1 hour, and 24 hours. Pause affects drawing only; BLE reception continues. Clear graph hides older points in the current page view without deleting the saved CSV history.
- No graph points are synthesized or interpolated. Long gaps are drawn as breaks. The 24-hour view only contains prior samples if logging was enabled and those real readings were stored.
- Start logging to persist received readings locally; up to 5,000 samples per device are retained. The currently active device's history can be exported as CSV. Clearing browser data removes these records.
- Saved BLE permission and profile details are local to the same browser profile. Reconnect is offered only when the browser still grants permission. Forgetting a saved device leaves its local reading history in place.

EXISTING ESP32 FIRMWARE EXAMPLE
- `ESP32_BLE_SHT4X.ino` reads one Adafruit SHT4x sensor over I2C (SDA GPIO26, SCL GPIO27). It now exposes both the original NEXORA custom service (UTF-8 numeric notifications) and Bluetooth SIG Environmental Sensing service (two-byte little-endian notifications), preserving existing BLE clients. The original 128-bit service remains advertised; Web Bluetooth uses the user-driven all-device chooser and explicitly requests permission for the SIG service.
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
- Android Chrome test for the website: install/open Chrome on a BLE-capable Android phone, open the HTTPS URL, grant Bluetooth/Nearby Devices permissions when prompted, then tap Connect and choose the device. Keep the tab/PWA open.
- Windows test: use current Chrome or Edge on a BLE-capable Windows computer, open the HTTPS URL, enable Bluetooth in Windows, tap Connect, and select the BLE device. Browser support depends on OS drivers and permissions.
- No physical ESP32, sensor, Android handset, or Windows BLE hardware verification is claimed until these steps have been performed on the user's actual devices.

BUILD AND DEPLOY
- GitHub Actions on pushes to `main` builds separate Android 3.0 and 2.0 debug APKs from their matching source trees, then deploys both downloads with the website/PWA to GitHub Pages.
- Website: https://ravichandrasr091-ux.github.io/RagiIncubatorAndroid/
- Android 3.0 APK: https://ravichandrasr091-ux.github.io/RagiIncubatorAndroid/downloads/nexora-android-v3.0.apk
- Android 2.0 APK: https://ravichandrasr091-ux.github.io/RagiIncubatorAndroid/downloads/nexora-android-v2.0.apk
- A debug APK is for testing and is not a signed Play Store release. No release keystore/password is stored in this project.
