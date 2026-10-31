RAGI INCUBATOR ANDROID APP + ESP32 BLE FIRMWARE

IMPORTANT
- This project includes a native Android app, a browser BLE monitor/PWA, and ESP32 BLE firmware.
- Only the existing SHT4x temperature/humidity sensor is implemented in firmware. Other sensor families in the project request are not implemented or hardware-tested.
- BLE app and ESP32 firmware share these UUIDs. Do not change one side without changing the other.
- GATT service: `7b7e0001-7d7a-4f4e-9b8d-2f8c4a6d1000`; temperature characteristic: `7b7e0002-7d7a-4f4e-9b8d-2f8c4a6d1000`; humidity characteristic: `7b7e0003-7d7a-4f4e-9b8d-2f8c4a6d1000`.
- The existing BLE payload is a UTF-8 numeric string for temperature or relative humidity. It is not a versioned JSON protocol and currently offers no configuration or output-control characteristic.
- Keep the app open while collecting readings. CSV rows are held in app memory until export; do not force-close before exporting.
- The app monitors only. It does not switch the heater, regulate temperature, or provide an independent over-temperature cutoff.
- No backend, account system, database, or cloud history is configured. Web and Android experiment logs are local to the current session.
- The project has not been physically verified on an ESP32 or Android phone as part of this build.
- The debug APK is intended for testing, not Play Store distribution. A release-signing key and protected signing configuration have not been supplied.

ESP32 SETUP
1. In Arduino IDE Library Manager install "Adafruit SHT4x Library" and its dependencies.
2. Use ESP32 board package with BLE support (ESP32 Arduino core).
3. Connect SHT4x: VIN->3V3, GND->GND, SDA->GPIO26, SCL->GPIO27.
4. Open ESP32_BLE_SHT4X.ino, select your ESP32 board and port, then upload.
5. Open Serial Monitor at 115200. It should say "BLE ready: Ragi_Incubator".

ANDROID BUILD
1. Install Android Studio and Android SDK Platform 35.
2. Open the RagiIncubatorAndroid folder and let Gradle sync.
3. Build -> Build Bundle(s) / APK(s) -> Build APK(s).
4. The debug APK is app/build/outputs/apk/debug/app-debug.apk.
5. Install it only for testing on an Android phone. Android may show a Play Protect warning for a sideloaded, debug-signed APK; do not disable Play Protect. Verify the source and build before installation.
6. Open app, grant the requested Bluetooth permissions, enable Bluetooth, and tap Connect ESP32.
7. Release signing has not been configured. Do not publish a release APK/AAB until the owner creates and securely stores a signing key and verifies its provenance.

WINDOWS LAPTOP BUILD
1. Install Python 3.10 or newer and make sure Bluetooth is enabled on the laptop.
2. Open PowerShell in the RagiIncubatorAndroid folder.
3. Run: `python -m pip install -r windows_app\requirements.txt`
4. Build the Windows app: `python -m PyInstaller --onefile --windowed --name RagiIncubator windows_app\main.py`
5. The standalone app is created at `dist\RagiIncubator.exe`. Copy it to the laptop and run it.
6. Select Connect ESP32, allow Windows Bluetooth access if prompted, then start the experiment and export the CSV.

WEB MONITOR AND PWA
1. The browser connects directly to the ESP32 using Web Bluetooth; no application or cloud service is required.
2. GitHub Actions builds the debug APK and deploys the website and PWA shell to GitHub Pages on pushes to main.
3. Use Chrome or Edge on a BLE-capable device. Bluetooth requires a secure HTTPS origin and a user gesture; background Bluetooth is not supported.
4. Select Connect ESP32 and choose the matching device in the browser's Bluetooth prompt.
5. The Android APK download is at https://ravichandrasr091-ux.github.io/RagiIncubatorAndroid/downloads/ragi-incubator.apk. A debug APK can trigger Android's sideload/Play Protect warning; never bypass Play Protect.
6. Install the web app using the browser's install option when offered. The service worker caches the monitor shell for offline viewing; it does not provide offline Bluetooth, background BLE, or cloud data synchronization.
7. Start the experiment to record readings, then export them as CSV. Data is kept only in the open page session.

COMPATIBILITY
- Android app requires BLE-capable Android phone.
- Windows laptop app requires Windows 10/11 with Bluetooth Low Energy support.
- Browser monitor requires Web Bluetooth support and a secure HTTPS connection.
- The PWA caches the website shell for offline viewing; live sensor connections still require a supported browser and an active page.
- This project uses Android Gradle Plugin 8.7.3, Kotlin 2.0.21, compile SDK 35.
- If Android Studio suggests a Gradle/SDK update, accept compatible recommended updates.

NOTES
- Temperature and humidity notifications are sent every 2 seconds.
- Start experiment before readings are added to the CSV log.
- Android CSV export uses the document picker; the Windows app saves to a selected CSV file.
- Each CSV row represents a pair of temperature and humidity notifications from the ESP32.
- This is a starter project. No physical hardware, multi-sensor combinations, reconnect reliability, release signing, or production safety behavior has been verified.

NEXT HARDWARE CONFIGURATION
- Before adding drivers, GPIO assignments, calibration, or outputs, document the exact ESP32 board/revision, installed sensors and module variants, bus addresses, voltage levels, wiring, and any relay/fan/pump driver boards.
- PT100/PT1000, thermocouple, mains relay, motor and heater circuits require compatible interfaces and independently designed hardware safety limits; do not connect them directly to ESP32 GPIO.
- Select a backend only if shared accounts/cloud history are required. No Supabase or other backend was found in the existing project.
