# Qualified waveform and channel replay contract

Status: implementation baseline  
Version: 2.2.0
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

The catalog contains exactly 79 profiles. Every profile also carries a closed
projection contract: allocation, modulation, timing, optional subcarrier
spacing, and optional resource-block count.

| Family | Count | Nominal center | Range contract | Publication basis |
|---|---:|---:|---|---|
| Lab | 3 | 98 MHz | CW 2 MHz; AM/FM 500 kHz | visual fixture |
| GSM/EDGE | 6 | 947.4 MHz | 2 MHz span | TS 45.005 V19.0.0 normal-burst modulations |
| LTE | 25 | 1.84 GHz | 20 MHz E-UTRA or 180 kHz NB-IoT | TS 36.141 V19.1.0 clauses 6.1.1–6.1.6 |
| 5G NR | 41 | 3.5 GHz | 100 MHz/30 kHz SCS or 180 kHz NR-N-TM | TS 38.141-1 V19.4.0 clauses 4.9.2.2.1–4.9.2.2.17 |
| Wi-Fi 6 | 4 | 5.18 GHz | 20 MHz HE PPDU | IEEE 802.11ax-2021 HE formats |

### Exact in-scope model sets

- GSM/EDGE: GMSK, QPSK, AQPSK, 8-PSK, 16-QAM, and 32-QAM Normal Bursts.
- LTE ordinary models: E-TM1.1, E-TM1.2, E-TM2, E-TM2a, E-TM2b,
  E-TM3.1, E-TM3.1a, E-TM3.1b, E-TM3.2, and E-TM3.3.
- LTE shortened-TTI models: sE-TM2-1, sE-TM2a-1, sE-TM2-2,
  sE-TM2a-2, sE-TM3.1-1, sE-TM3.1a-1, sE-TM3.1-2,
  sE-TM3.1a-2, sE-TM3.2-1, sE-TM3.2-2, sE-TM3.3-1, and
  sE-TM3.3-2.
- LTE NB-IoT: N-TM, guard-band N-TM, and in-band N-TM.
- NR ordinary FR1 models: NR-FR1-TM1.1, TM1.2, TM2, TM2a, TM2b,
  TM3.1, TM3.1a, TM3.1b, TM3.2, and TM3.3, plus NR-N-TM.
- NR SBFD: every ordinary FR1 model above except NR-N-TM in each published
  `_SBFD_DU`, `_SBFD_UD`, and `_SBFD_DUD` timing pattern—30 profiles.
- Wi-Fi 6: HE SU, HE ER SU, HE MU, and HE TB PPDU formats.

FR2 is deliberately absent: its frequencies exceed the ZS407 firmware command
ceiling. Multi-carrier test configurations such as LTE ETC and NR NRTC are also
not mislabeled as waveform TMs; they remain separately contracted future
multi-carrier orchestration.

LTE and NR publications define named test models. GSM and IEEE 802.11 use
Normal-Burst and PPDU-format terminology, so the UI retains those names instead
of inventing `TM` identifiers.

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
- FM moves instantaneous carrier energy laterally through ±75 kHz and renders
  resolved low-level sideband lines. It must not create a filled occupied
  pedestal: the median non-line level inside ±105 kHz must remain within 4 dB of
  the adjacent replay-channel floor. Peak position must traverse more than
  130 kHz across the fixture window.
- GSM projects modulation-dependent normal-burst widths and active/inactive time slots.
- LTE and NR distinguish full allocation, boosted/deboosted allocation,
  single-PRB dynamic-range models, narrowband models, shortened-TTI timing, and
  SBFD DU/UD/DUD timing. Modulation-specific texture never implies EVM evidence.
- Wi-Fi distinguishes full-width, 106-tone extended-range, multi-RU, and
  trigger-based PPDU projections with active/idle replay intervals.

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

Signal Lab exposes all 79 profiles through five counted family tabs and a closed
model selector, plus a persistent qualification badge, source clause,
allocation/timing evidence, AWGN or Rayleigh selection, noise floor, fading
rate, and seed. It remains a separate, visibly simulated companion window. A
physical discovery failure fails loudly; only successful discovery with no
exact ZS407 activates the synthesized device.

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
- `WAVE-006`: AM center power and FM peak position meet their animation assertions; FM non-line bins do not elevate the channel floor.
- `WAVE-007`: GSM and Wi-Fi zero-span fixtures contain both active and idle intervals.
- `WAVE-008`: selecting any profile changes the actual simulator byte source and analyzer range.
- `WAVE-009`: channel changes affect the next frame without restarting the application.
- `WAVE-010`: text scan, raw scan, and zero span use the same waveform/channel engine.
- `WAVE-011`: a physical candidate suppresses Signal Lab; discovery error never activates it.
- `WAVE-012`: Signal Lab renders all controls without overflow at its fixed companion size.
- `WAVE-013`: the catalog has exactly 3 Lab, 6 GSM, 25 LTE, 41 NR, and 4 Wi-Fi profiles, with no missing or extra schema IDs.
- `WAVE-014`: full, boosted, single-PRB, narrowband, subslot/slot, and SBFD projections are observably distinct.

## Primary references

- GSM/EDGE TS 45.005 V19.0.0:
  https://www.etsi.org/deliver/etsi_ts/145000_145099/145005/19.00.00_60/ts_145005v190000p.pdf
- LTE E-UTRA TS 36.141 V19.1.0 E-TM definitions:
  https://www.etsi.org/deliver/etsi_ts/136100_136199/136141/19.01.00_60/ts_136141v190100p.pdf
- NR TS 38.141-1 V19.4.0 FR1 and SBFD test models:
  https://www.etsi.org/deliver/etsi_ts/138100_138199/13814101/19.04.00_60/ts_13814101v190400p.pdf
- IEEE 802.11ax-2021: https://standards.ieee.org/ieee/802.11ax/7180/
