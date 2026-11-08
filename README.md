# Steady

See the [UNO Q review and validation report](docs/UNO_Q_REVIEW.md) for corrected
bugs and remaining deployment limitations.

Steady is a prototype for nursing home night staff to review resident movement
and fall alerts. The current hardware is an **Arduino UNO Q with 4 GB RAM and
32 GB eMMC**, connected to an external motion sensor. A Linux relay forwards
readings to the Node/Databricks backend and the React dashboard.

- [UNO Q setup, power, connectivity and local storage](docs/UNO_Q_SETUP.md)
- [Hardware paths and integration handoff](hardware/README.md)
- [Current UNO Q App Lab application](hardware/steady_unoq/README.md)
- [Root dashboard backend](server/README.md)
- [Alternative waveform detector](firmware/steady/README.md) and its separate
  [Worker/D1 application](web/README.md)

The current dashboard connects over Wi-Fi. Local SQLite persistence on the board
is a proposed addition; the integrated relay does not implement it yet. Sensor
and fall-detection behavior still require physical validation.
