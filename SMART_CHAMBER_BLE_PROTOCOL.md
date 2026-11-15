# NEXORA Smart Chamber BLE protocol

## Compatibility and safety

Protocol version 1 is additive. The existing NEXORA sensor service and the
Bluetooth SIG Environmental Sensing service keep their current UUIDs and
payloads, so existing read-only clients continue to work.

The current ESP32 sketch has no verified chamber-heater output. It advertises
the control service for capability discovery, reports `HEATER_UNAVAILABLE`,
and rejects every setpoint command. No heater GPIO, relay polarity, target
limits, or electrical behavior is assumed by this protocol or firmware.

## Existing sensor characteristics

| Service | Characteristic | UUID | Payload |
|---|---|---|---|
| NEXORA Sensor | Service | `7b7e0001-7d7a-4f4e-9b8d-2f8c4a6d1000` | Existing service |
| NEXORA Sensor | Temperature | `7b7e0002-7d7a-4f4e-9b8d-2f8c4a6d1000` | UTF-8 Celsius number; read/notify |
| NEXORA Sensor | Humidity | `7b7e0003-7d7a-4f4e-9b8d-2f8c4a6d1000` | UTF-8 relative-humidity number; read/notify |
| SIG Environmental Sensing | Temperature | `2A6E` | Signed little-endian int16, hundredths of °C |
| SIG Environmental Sensing | Humidity | `2A6F` | Unsigned little-endian uint16, hundredths of %RH |

Both sensor services remain available. Measurements are sampled approximately
every two seconds; BLE notifications are sent while a client is connected.
The ESP32 advertises both the legacy NEXORA sensor service and the SIG
Environmental Sensing service. `NEXORA-SENSOR` is included in the BLE scan
response; clients must not require the name in the first advertisement.

## Smart Chamber control service

The current firmware uses
`7b6e0001-7c3a-4f8b-9d21-4a6e786f7261` as the controller service UUID. The
previous preview UUID, `7b7e0010-7d7a-4f4e-9b8d-2f8c4a6d1000`, remains accepted by
Android and website clients for older firmware. The control UUID is not added
to the legacy 31-byte advertising payload; clients discover it after connecting.

| Characteristic | UUID | Properties | Version 1 value |
|---|---|---|---|
| Protocol | `7b7e0011-7d7a-4f4e-9b8d-2f8c4a6d1000` | Read | UTF-8 `NEXORA/1` |
| Device status | `7b7e0012-7d7a-4f4e-9b8d-2f8c4a6d1000` | Read/notify | `NEXORA/1|STATUS|HEATER_UNAVAILABLE|<SENSOR_OK or SENSOR_FAULT>|<uptime_seconds>|<boot_count>` |
| Setpoint command | `7b7e0013-7d7a-4f4e-9b8d-2f8c4a6d1000` | Write/write-without-response | `NEXORA/1|SET_TARGET|<sequence>|<target_tenths_c>` |
| Command acknowledgement | `7b7e0014-7d7a-4f4e-9b8d-2f8c4a6d1000` | Read/notify | `NEXORA/1|ACK|<sequence>|<ACCEPTED or REJECTED>|<reason>` |

### New controller characteristic layout supported by Android

Android also supports the controller layout reported by newer ESP32 firmware
under service `7b6e0001-7c3a-4f8b-9d21-4a6e786f7261`:

| Characteristic | UUID | Properties | Payload |
|---|---|---|---|
| Confirmed target | `7b6e0002-7c3a-4f8b-9d21-4a6e786f7261` | Read/write or write-without-response | UTF-8 Celsius number; Android accepts `1.0`–`60.0` in `0.5`°C steps |
| Controller status | `7b6e0003-7c3a-4f8b-9d21-4a6e786f7261` | Read/notify | UTF-8 key/value fields, including `TARGET`, `HEATER`, `SENSOR`, `SAFETY`, and `LOCKOUT` |
| Target acknowledgement | `7b6e0004-7c3a-4f8b-9d21-4a6e786f7261` | Read/notify | `READY`, `OK:TARGET=<value>`, or `ERR:<reason>` |

The updated firmware's software over-temperature lockout threshold is
65.0°C. The app displays firmware-reported safety status and does not replace
the controller's safety cutoff with a client-side threshold.

Android reads target and status after MTU negotiation, then subscribes to
temperature, humidity, status, and acknowledgement characteristics in order.
The Apply control requires a writable target plus a status characteristic;
reported `SAFETY=LOCKOUT` or `SENSOR=ERROR` disables writes. Confirmed targets
are updated only from the ESP32's target read, status, or positive
acknowledgement. The checked-in `ESP32_BLE_SHT4X.ino` still implements the
legacy safe-disabled status/command layout above; it does not implement this
new target/status/acknowledgement characteristic layout.

Sequence numbers are decimal values from 1 through 65535. A client must not
display a changed target until it receives an `ACCEPTED` acknowledgement with
the same sequence number. Retries must reuse the original sequence number.
The website requests access to the sensor and control services together,
subscribes to status and acknowledgement notifications, and keeps target
selection as an unconfirmed draft until a matching accepted acknowledgement
arrives while the controller reports `HEATER_READY` and `SENSOR_OK`.
Malformed commands receive a rejected acknowledgement. The current firmware
rejects valid setpoint writes with `HEATER_OUTPUT_UNVERIFIED`; it never accepts
or applies a target.

## Android app updates

Smart Chamber 2.6 checks the GitHub Pages `downloads/latest.json` catalog on
launch and from Settings. The catalog is restricted to this app package and
versioned APK filenames; downloads are size-limited, SHA-256 checked, and
validated for package and version before Android's package installer opens.
Android still requires the user to confirm installation, and its package
installer enforces the APK signing-certificate match.

## Required work before enabling control

Do not change the current safe-disabled behavior until the actual heater-driver
model, ESP32 output GPIO, active level, electrical ratings, chamber limits,
sensor placement, and independent over-temperature cutoff have been verified.
The ESP32 must own the control loop and fail heater-off on boot, sensor error,
or watchdog/restart. Android must remain a setpoint client only.

Offline log synchronization is not implemented. Its storage medium, record
format, retention period, capacity, and flash endurance must be established
before firmware advertises any offline-history capability.
