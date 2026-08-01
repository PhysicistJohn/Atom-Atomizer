# Neptune P210 characterization record

Status: physical receive path operationally validated; RF calibration and QEMU-twin acceptance remain open
Written: 2026-07-31 (live evidence captured 2026-08-01 UTC)
Host: Apple-silicon macOS; physical P210 at `ip:10.0.0.250` through a routed network

This record separates what the `neptune-p210` driver and its `iio-transport.ts`
module can honestly claim from source-derived limits copied out of documents,
and what was exercised end to end. It is an operational acceptance record for
the bounded receive path; it is **not** an RF calibration or metrology record.
Compare against
[docs/PHYSICAL_ZS407_CHARACTERIZATION.md](./PHYSICAL_ZS407_CHARACTERIZATION.md),
which uses the same separation between software/device transactions and RF
performance claims.

## Validation status — READ THIS FIRST

The physical receive path has been exercised at all four relevant layers:

1. **Network/libiio.** The host routes `10.0.0.250` through its gateway; ping
   and TCP ports 22, 80, and 30431 responded. libiio 0.25 `iio_attr` read the
   AD9361 LO, sample rate, RF bandwidth, and gain-control mode. A direct
   1,024-sample `iio_readdev` capture returned exactly 4,096 bytes.
2. **Driver/runtime.** `node tools/smoke-neptune-p210.mjs ip:10.0.0.250`
   exercised `NeptuneP210InstrumentDriver` through `InstrumentManager` with no
   endpoint environment variable. It discovered, connected, configured
   99 MHz / 10 MSPS / 8 MHz / 4,096 `ci16le` samples, acquired exactly 16,384
   bytes, derived a 4,096-bin host FFT, and disconnected cleanly in 643 ms.
   The admitted measurement reported 12 significant ADC bits, full-scale code
   2,048, and `uncalibrated-dbfs-relative`; the observed peak in that capture
   was 102.471680 MHz at -16.41 dBFS-relative.
3. **Application.** Atomizer Dev discovered the remembered manual endpoint,
   connected, acquired Single and bounded one-at-a-time Run buffers, stopped
   cleanly, and populated I/Q, Spectrum, Waterfall, Channel, Detect, traces,
   markers, peak search, and peak tracking. Changing the center to 99 MHz in
   the UI was verified by a direct hardware LO readback of exactly 99,000,000
   Hz.
4. **Regression.** The Neptune transport/driver suite passed 86 tests; the
   complete Atomizer suite passed 1,188 tests (33 skipped), with ordered build
   and all-workspace type-checking also green.

The QEMU twin remains unvalidated end to end. So do calibrated amplitude,
known-signal RF response, maximum-rate/maximum-size soak behavior, MIMO, and
all transmit behavior. Native SigMF serialization/IPC/UI/Atom paths are
contract-tested; a paired-file save through the freshly packaged GUI is a
separate product acceptance check, recorded when performed rather than
inferred from serializer tests.

## Sample format and scaling evidence

The declared geometry below is **source-derived**, copied from
`Atom-NeptuneSDR-Firmware/specs/p210-firmware-interface-v1.json`'s
`wideband_capture` block (schema `neptunesdr.p210-firmware-interface/v1`,
profile `qemu-development`, status "executable development contract;
physical-board validation pending" — i.e. the firmware repository itself
does not claim physical-board validation either). The live capture confirmed
the `ci16le` four-byte complex-sample container and exact byte geometry. It did
not independently characterize the converter's effective number of bits:

| Field | Value | Source |
| --- | --- | --- |
| `iio_sample_slot_bits` | 16 | spec `wideband_capture.iio_sample_slot_bits` |
| `adc_significant_bits` | 12 | spec `wideband_capture.adc_significant_bits` |
| `adc_full_scale_code` | 2048 | spec `wideband_capture.adc_full_scale_code` |
| `complex_sample_bytes_per_channel` | 4 | spec `wideband_capture.complex_sample_bytes_per_channel` |
| `channel_layout` | time-major channel-interleaved signed IQ16 little-endian | spec `wideband_capture.channel_layout` |

Interpretation, as implemented in the contract and driver:

- The AD9361 ADC delivers **12 significant bits inside a 16-bit sample slot**
  (`sampleFormat: 'ci16le'`, 2 bytes I + 2 bytes Q = 4 bytes/complex sample,
  matching `complex_sample_bytes_per_channel: 4` above). The top 4 bits of
  each 16-bit slot are not independent ADC resolution.
- `adcFullScaleCode: 2048` is the full-scale code for those 12 significant
  bits (2^11 = 2048, i.e. signed 12-bit full scale), not the 16-bit slot's
  own full scale (which would be 32768). `packages/contracts/src/instrument.ts`
  encodes both `adcSignificantBits` and `adcFullScaleCode` as fixed literals
  (`z.literal(12)`, `z.literal(2048)`) — these are documented hardware facts,
  not driver-chosen or configurable values.
- **Power is dBFS-relative, never dBm.** There is no calibration path in this
  implementation (no cal table, no reference-level command, no manufacturer
  calibration data consumed anywhere in `iio-transport.ts` or the driver).
  `complexIqMeasurementSchema.powerReference` is set to the literal
  `'uncalibrated-dbfs-relative'` on every Neptune measurement specifically so
  no consumer (UI, export, Atom) can present Neptune power evidence as if it
  were calibrated dBm. Any absolute-power claim from a Neptune capture would
  require a separate, currently nonexistent calibration effort.
- The board is 2 RX / 2 TX channel (`board.rx_channels: 2`,
  `board.tx_channels: 2` in the spec) but this driver exposes exactly one
  acquisition capability, single-channel `complex-iq` only. 2x2 MIMO capture
  is explicitly deferred — see `complexIqCapabilitySchema`'s comment in
  `packages/contracts/src/instrument.ts` — pending a versioned multi-channel
  contract addition once a second credible consumer exists, per this
  repository's "two credible consumers" extension rule.

## Achievable tuning / rate / bandwidth

Also **source-derived** from the same spec's `wideband_capture` block, and
from the well-known AD9361 datasheet limits (the spec does not declare tuning
range or minimum rate/bandwidth, so those two are datasheet-sourced, not
spec-sourced — see the code comment in
`packages/neptune-p210/src/neptune-p210-instrument-driver.ts` next to
`NEPTUNE_P210_FALLBACK_CAPABILITY_RANGES`):

| Field | Value | Source |
| --- | --- | --- |
| `sampleRateHz.max` | 61,440,000 Hz | spec `wideband_capture.sample_rate_hz` |
| `bandwidthHz.max` | 50,000,000 Hz | spec `wideband_capture.rf_bandwidth_hz` |
| `centerFrequencyHz` range | 70 MHz – 6 GHz | AD9361 datasheet (not in spec) |
| `sampleRateHz.min` | ~2,083,334 Hz | AD9361 datasheet (not in spec) |
| `bandwidthHz.min` | 200,000 Hz | AD9361 datasheet (not in spec) |

These four are used **only as an explicit fallback**: at `connect()` time the
driver first tries to query the live `<attr>_available` IIO sibling attribute
(e.g. `sampling_frequency_available` on the `ad9361-phy`/`voltage0` channel)
through `transport.getDeviceAttribute`, parsing either a `"[min step max]"`
range form or a space-separated discrete-value form. Only when that live
query fails for any reason (missing attribute, transport error, unparseable
response) does the driver fall back to the table above. This means the table
is deliberately never presented as connection evidence — it is a documented
fallback, and the `_available`-attribute name and format assumption itself is
**unconfirmed against real hardware output** (also flagged as a known gap by
the driver stage).

The maximum single capture is `NEPTUNE_P210_MAX_SAMPLE_COUNT =
min(MAX_COMPLEX_IQ_SAMPLES_V1, MAX_CAPTURE_SAMPLE_COUNT) = 8,388,608 samples`
with current contract constants — bounded by Atomizer's generic 64 MiB
complex-I/Q ceiling (`ci16le` at 4 bytes/sample), not by anything Neptune-
specific. The driver contract still returns one bounded buffer per
`iio_readdev -s` transaction; Atomizer's Run mode provides continuous product
behavior by scheduling those buffers one at a time with backpressure and a
single in-flight acquisition. That loop is not a claim of a driver-native
chunk/overrun streaming protocol.

## IIO names used by the transport (source-derived, from `NeptuneSDR_Test/runme.py`)

| Purpose | Name | Status |
| --- | --- | --- |
| Transceiver phy device | `ad9361-phy` | from `runme.py` |
| Raw-capture buffer device | `cf-ad9361-lpc` | from `runme.py` |
| RX I channel | `voltage0` | from `runme.py` |
| RX Q channel (capture arg only) | `voltage1` | from `runme.py` |
| RX LO/tuning channel | `altvoltage0` | from `runme.py` |
| Center frequency attribute | `frequency` | from `runme.py` |
| Sample rate attribute | `sampling_frequency` | from `runme.py` |
| RF bandwidth attribute | `rf_bandwidth` | from `runme.py` |
| Gain control mode attribute | `gain_control_mode` | from `runme.py` (`slow_attack` is the one proven value; other AD9361 enum values are standard but unconfirmed) |
| Manual gain value attribute | `hardwaregain` | **UNVERIFIED** — not present in `runme.py`, which never sets a manual gain value; this is the standard AD9361 driver attribute name, included because the transport's required surface calls for a gain get/set, but explicitly unconfirmed against real hardware or the twin |

The driver itself never reads or writes `hardwaregain` (gain is not part of
the complex-I/Q configuration contract), so this specific unverified name is
inert for v1 but remains a latent risk if a future feature needs manual gain
control.

## Contract/unit-test evidence

`packages/neptune-p210/src/neptune-p210-instrument-driver.test.ts` and
`packages/neptune-p210/src/iio-transport.test.ts` exercise the driver and
transport against injected `NeptuneTransportLike`/subprocess doubles.
Separately, the live smoke command above executes the same driver and manager
against real libiio/hardware. Covered by the fake-backed suite: environment,
manual, recent-device, Bonjour, and bounded network discovery; connect/
configure/acquire/disconnect lifecycle; stale-candidate rejection; oversized
I/Q payload rejection; event/return measurement mismatch detection; a failed
pending-connection cleanup followed by a successful retry, without leaking
the resource or opening a second transport; a full round-trip through
`validateInstrumentSession`/`InstrumentDriverRegistry`/a real
`InstrumentManager`. This proves the driver satisfies the runtime's admission
code under fault injection; the physical smoke proves one bounded real
configuration/capture lifecycle, not every fault or RF condition.

## Still unqualified

- Any live connection to the QEMU digital twin.
- The `_available`-attribute name and format (`"[min step max]"` vs.
  space-separated discrete values) against real libiio output.
- The `hardwaregain` attribute name against real hardware or the twin.
- Effective ADC resolution, absolute scaling, DC offset, and IQ imbalance.
  Real `ci16le` bytes decoded into a finite spectrum using the declared 2,048
  full-scale code, but no calibrated known-level stimulus was available.
- The complete achievable tuning/rate/bandwidth range. A 99 MHz / 10 MSPS /
  8 MHz configuration and a separate 56 MSPS / 200 kHz observation worked;
  fallback range endpoints were not swept or characterized.
- Any RF path characteristic: sensitivity, noise figure, image rejection,
  spurs, or antenna/front-end behavior — this driver makes no such claim and
  none should be inferred from its existence.
- Timing/latency of a real `iio_readdev` capture at the documented maximum
  sample rate and sample count.
- Behavior of the two-RX/two-TX AD9361 hardware beyond the single RX channel
  this v1 driver actually uses.

These remain explicit gates for claims beyond the operational receive path.
Neither a passing software suite nor a byte-correct live capture substitutes
for RF metrology, and this document is not a calibration record.
