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

## Smart Chamber control service

| Characteristic | UUID | Properties | Version 1 value |
|---|---|---|---|
| Protocol | `7b7e0011-7d7a-4f4e-9b8d-2f8c4a6d1000` | Read | UTF-8 `NEXORA/1` |
| Device status | `7b7e0012-7d7a-4f4e-9b8d-2f8c4a6d1000` | Read/notify | `NEXORA/1|STATUS|HEATER_UNAVAILABLE|<SENSOR_OK or SENSOR_FAULT>|<uptime_seconds>|<boot_count>` |
| Setpoint command | `7b7e0013-7d7a-4f4e-9b8d-2f8c4a6d1000` | Write/write-without-response | `NEXORA/1|SET_TARGET|<sequence>|<target_tenths_c>` |
| Command acknowledgement | `7b7e0014-7d7a-4f4e-9b8d-2f8c4a6d1000` | Read/notify | `NEXORA/1|ACK|<sequence>|<ACCEPTED or REJECTED>|<reason>` |

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

## Required work before enabling control

Do not change the current safe-disabled behavior until the actual heater-driver
model, ESP32 output GPIO, active level, electrical ratings, chamber limits,
sensor placement, and independent over-temperature cutoff have been verified.
The ESP32 must own the control loop and fail heater-off on boot, sensor error,
or watchdog/restart. Android must remain a setpoint client only.

Offline log synchronization is not implemented. Its storage medium, record
format, retention period, capacity, and flash endurance must be established
before firmware advertises any offline-history capability.
