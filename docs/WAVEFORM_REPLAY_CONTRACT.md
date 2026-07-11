# Qualified waveform and channel replay contract

Status: implementation baseline  
Version: 2.1.0  
Updated: 2026-07-10

This document is normative for the synthesized ZS407 used by Atom Signal Lab.
It defines what every waveform name means, how replay evolves, and the evidence
required before TinySA Atomizer may call a vector exact or conformant.

## Qualification vocabulary

Every `WaveformDescriptor` has exactly one qualification:

- `visual`: deterministic interaction fixture; no communications-standard claim.
- `standards-derived`: its center, occupied bandwidth, allocation shape, or burst
  timing is derived from the cited publication, but samples are a power-spectrum
  or zero-span projection rather than bit-exact I/Q.
- `conformance-validated`: an immutable I/Q asset has an accepted provenance
  record and SHA-256 digest and has passed the separately defined reference-tool
  checks.

The runtime refuses `requireConformanceValidated(profile)` for every current
catalog entry. There is no relabeling, silent substitute, or approximate
conformance mode.

## Closed catalog

| ID | UI label | Nominal center | Occupied bandwidth | Recommended span | Qualification | Publication basis |
|---|---|---:|---:|---:|---|---|
| `cw` | CW carrier | 98 MHz | 5 kHz | 2 MHz | Visual | Atomizer lab fixture |
| `am` | AM replay | 98 MHz | 60 kHz | 500 kHz | Visual | time-compressed carrier/sideband envelope |
| `fm` | FM replay | 98 MHz | 200 kHz | 500 kHz | Visual | time-compressed ±75 kHz deviation |
| `gsm-normal-burst` | GSM normal burst | 947.4 MHz | 200 kHz | 2 MHz | Standards-derived | 3GPP TS 45.002 normal burst |
| `lte-etm1.1` | LTE E-TM1.1 | 1.84 GHz | 18 MHz | 30 MHz | Standards-derived | 3GPP TS 36.141 clause 6.1.1, 20 MHz E-TM1.1 |
| `nr-fr1-tm1.1` | 5G NR TM1.1 | 3.5 GHz | 98.28 MHz | 120 MHz | Standards-derived | 3GPP TS 38.141-1, NR-FR1-TM1.1, 273 RB, 30 kHz SCS |
| `wifi6-he-su` | Wi-Fi 6 HE SU | 5.18 GHz | 18.90625 MHz | 30 MHz | Standards-derived | IEEE 802.11ax HE SU PPDU, 20 MHz, 242-tone RU |

LTE and NR publications define named test models. GSM and IEEE 802.11 do not use
that exact test-model naming for these entries, so the UI says Normal Burst and
HE SU PPDU rather than inventing `TM` identifiers.

Selecting a profile reconfigures the simulated analyzer to the descriptor's
recommended range before replay restarts. Invalid descriptor/range combinations
fail; they do not retain an unrelated prior range.

## Spectrum and time behavior

The spectrum engine accepts a closed profile, increasing integer-Hz range,
point count, non-negative sweep index, and validated replay-channel object. It
returns one finite dBm value per requested bin.

- CW is an unresolved narrow carrier suitable for marker and trace testing.
- AM has a carrier and symmetric sidebands whose amplitude follows a
  time-compressed modulation cycle. At the center bin, replay must span more than
  5 dB across the fixture window.
- FM moves instantaneous carrier energy laterally through ±75 kHz while retaining
  a low-level occupied comb. Peak position must traverse more than 130 kHz across
  the fixture window.
- GSM projects a GMSK-like 200 kHz spectral shape and active/inactive time slots.
- LTE and NR project full-allocation OFDM plateaus, edge taper, shoulders, and
  subcarrier-scale texture at their declared allocation widths.
- Wi-Fi projects a 20 MHz HE SU occupied-tone shape, center null, and PPDU-like
  active/idle replay intervals.

These are detected-power fixtures driven through the production text/raw/zero-
span byte protocol. They do not contain payload bits, coding, reference-signal
mapping, phase continuity, EVM, ACLR-calibrated filtering, or receiver impairment
calibration. Spectrum analyzer output cannot be promoted to I/Q evidence.

## Replay-channel contract

The closed `ReplayChannelConfiguration` contains:

```ts
interface ReplayChannelConfiguration {
  model: 'awgn' | 'rayleigh';
  noiseFloorDbm: number;
  seed: number;
  fadingRateHz: number;
}
```

The default is AWGN, −108 dBm floor, seed 407, and 2 Hz fading-rate metadata.

### AWGN replay

Each bin uses seeded Box–Muller complex Gaussian I/Q samples. Six independent
power looks are averaged to produce a bounded periodogram contribution. Receiver
replay then adds deterministic broad passband shape, spatially correlated ripple,
edge lift, sweep evolution, and three stable low-level spurs. Signal and noise
powers are combined in linear milliwatts before returning dBm.

Identical profile, range, sweep index, and seed are byte-repeatable. Advancing the
sweep index changes the periodogram while preserving the catalog fixture.

### Rayleigh fading replay

Rayleigh mode applies a zero-mean complex Gaussian fading coefficient to signal
power in addition to the same receiver noise. Coefficients are smoothly
interpolated over frequency and sweep time to create correlated, frequency-
selective fades. `fadingRateHz` controls temporal evolution. Magnitude is bounded
only to keep finite display values; deep fades remain present and reproducible.

This is a replay channel suitable for visual workflow and algorithm stress. It
is not a tapped-delay-line model with a named 3GPP channel profile and must not be
labeled EPA, EVA, ETU, TDL, CDL, or a propagation qualification result.

## Signal Lab and Atom

Signal Lab exposes all seven profiles, a persistent qualification badge, AWGN or
Rayleigh selection, noise floor, fading rate, and seed. It remains a separate,
visibly simulated companion window. A physical discovery failure fails loudly;
only successful discovery with no exact ZS407 activates the synthesized device.

Atom's typed `select_demo_signal` tool accepts only catalog IDs. The typed
`configure_demo_channel` tool accepts only the closed channel schema. Atom reads
the waveform descriptor, qualification, source, channel, and disclosure through
application state before making a claim.

## Conformance-asset admission gate

Adding a conformance-validated entry requires all of the following in one change:

1. Licensed or redistributable source and exact standard/revision/clause.
2. Immutable sample format, rate, center convention, length, scaling, and SHA-256.
3. Generator/tool/version and all non-default generation parameters.
4. Independent structural checks for allocation, timing, and expected channels.
5. Reference-instrument or accepted conformance-tool evidence and tolerances.
6. Runtime asset hash verification before replay.
7. Closed descriptor/schema, tests, UI disclosure, Atom context, and docs.

Failure of any asset or check prevents selection; a standards-derived projection
is never used as its fallback.

## Acceptance

- `WAVE-001`: catalog IDs, labels, source clauses, and recommended ranges are closed and schema-valid.
- `WAVE-002`: every standards-derived entry retains an explicit non-conformance disclosure.
- `WAVE-003`: requesting conformance validation without a hashed admitted asset fails loudly.
- `WAVE-004`: seeded AWGN is repeatable at a fixed sweep and evolves at the next sweep.
- `WAVE-005`: Rayleigh output is repeatable and contains deeper frequency-selective fades than AWGN.
- `WAVE-006`: AM center power and FM peak position meet their animation assertions.
- `WAVE-007`: GSM and Wi-Fi zero-span fixtures contain both active and idle intervals.
- `WAVE-008`: selecting any profile changes the actual simulator byte source and analyzer range.
- `WAVE-009`: channel changes affect the next frame without restarting the application.
- `WAVE-010`: text scan, raw scan, and zero span use the same waveform/channel engine.
- `WAVE-011`: a physical candidate suppresses Signal Lab; discovery error never activates it.
- `WAVE-012`: Signal Lab renders all controls without overflow at its fixed companion size.

## Primary references

- GSM/GERAN TS 45.002 portal: https://www.3gpp.org/DynaReport/45002.htm
- LTE E-UTRA TS 36.141 E-TM definitions:
  https://www.etsi.org/deliver/etsi_ts/136100_136199/136141/13.11.00_60/ts_136141v131100p.pdf
- NR TS 38.141-1 FR1 test models:
  https://www.etsi.org/deliver/etsi_TS/138100_138199/13814101/18.08.00_60/ts_13814101v180800p.pdf
- IEEE 802.11ax-2021: https://standards.ieee.org/ieee/802.11ax/7180/
