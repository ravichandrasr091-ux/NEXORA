NEXORA — CONNECT. MONITOR. CONTROL.

PROJECT
- NEXORA is the rebranded website/PWA and Android monitor in this project. The Android package ID remains unchanged so existing installs can update.
- The site is a static HTML/CSS/JavaScript PWA. It connects directly to BLE devices; no account or cloud backend is required.
- The supplied NEXORA artwork is used for the website/PWA and Android launcher icon.
- No physical ESP32 or Android-device test is claimed by this build.

WEB BLUETOOTH AND SENSOR PROFILES
- Open the GitHub Pages website in a supported Web Bluetooth browser over HTTPS, then choose Connect device. The device chooser appears only after a user gesture.
- The default profile preserves the existing ESP32 GATT service and SHT4x temperature/humidity characteristics below. The ESP32 firmware must advertise that service and send UTF-8 numeric readings.
- In Sensor Management, configure one BLE service UUID and up to 16 characteristic UUIDs. Each characteristic must expose numeric UTF-8 data and support notifications/indications or reads. Names, types, units, and display precision are profile metadata saved only in this browser.
- The web client does not discover physical I2C/SPI sensors, identify their models, parse arbitrary JSON, write to unknown characteristics, or control outputs. Sensor hardware must be read by ESP32 firmware and transmitted over BLE.
- Existing firmware device name: `Ragi_Incubator`. Its BLE service and characteristics:
  - Service: `7b7e0001-7d7a-4f4e-9b8d-2f8c4a6d1000`
  - Temperature: `7b7e0002-7d7a-4f4e-9b8d-2f8c4a6d1000`
  - Relative humidity: `7b7e0003-7d7a-4f4e-9b8d-2f8c4a6d1000`
- The current firmware implements only an SHT4x temperature/humidity sensor on SDA GPIO26 and SCL GPIO27. Other sensor families, firmware metadata, uptime, BLE RSSI, and command acknowledgements are not provided.
- Sensor values become stale after 8 seconds without a fresh reading and immediately show stale when disconnected. BLE link state is displayed separately from sensor freshness.

DATA, ANALYTICS, AND CONTROLS
- Readings and connection history remain on this browser. Up to 5,000 logged samples per device are retained in browser storage; clearing browser data removes them.
- Start logging while connected to persist actual incoming values. CSV export includes timestamp, device, sensor metadata, characteristic UUID, value, and configured unit.
- Analytics filters 1 hour, 24 hours, 7 days, and 30 days of actual stored/session readings. No sample values are simulated or interpolated.
- Web Bluetooth does not expose RSSI in this profile. Firmware version and device uptime are not reported by the current firmware; the interface labels them unavailable.
- The firmware exposes no command/write characteristic. Controls are therefore unavailable; the site never reports an unimplemented device command as successful.
- The service worker caches the NEXORA interface for offline viewing. Bluetooth still needs a supported browser, a secure context, user interaction, and an open page. The APK is not cached by the service worker.

ANDROID APP
- The Android application is branded NEXORA and uses the supplied launcher icon while retaining its existing application ID and BLE service UUIDs.
- Build with Android Studio, Android SDK Platform 35, and the project's Gradle configuration. The debug APK is produced at `app/build/outputs/apk/debug/app-debug.apk`.
- The Android app currently connects to the existing service and its two temperature/humidity characteristics. The website's configurable multi-characteristic profiles do not automatically change Android's BLE profile.
- This project has no release keystore or protected release-signing configuration. GitHub Actions publishes a debug APK for testing, not a Play Store release. Never disable Play Protect or share a release keystore/password in source control.

ESP32 FIRMWARE SETUP
1. In Arduino IDE Library Manager, install "Adafruit SHT4x Library" and its dependencies.
2. Select an ESP32 board package with BLE support.
3. Connect the SHT4x module using its compatible supply voltage: VIN to 3V3, GND to GND, SDA to GPIO26, and SCL to GPIO27.
4. Open `ESP32_BLE_SHT4X.ino`, select the actual board and port, then upload.
5. At 115200 baud, the current firmware reports `BLE ready: Ragi_Incubator`.
6. This project has not verified the wiring or firmware against physical hardware. Confirm the board/module datasheets before connecting hardware.

DEPLOYMENT
- GitHub Actions builds the Android debug APK and deploys the website/PWA to GitHub Pages on pushes to `main`.
- Website: https://ravichandrasr091-ux.github.io/RagiIncubatorAndroid/
- Android APK: https://ravichandrasr091-ux.github.io/RagiIncubatorAndroid/downloads/ragi-incubator.apk
- Web Bluetooth requires HTTPS, a user gesture, and a compatible browser/device. Background Bluetooth is not supported.

PROJECT LIMITATIONS
- There is no backend, shared account, remote telemetry, cloud history, or cloud synchronization.
- No heater, relay, fan, pump, motor, alarm, or other output is controlled by this monitoring application.
- Web sensor-profile units are user-provided metadata; verify them against the firmware before relying on displayed labels.
- No physical BLE, mobile installation, sensor-driver, reconnection, or safety hardware test should be considered passed unless separately performed on the actual device.
