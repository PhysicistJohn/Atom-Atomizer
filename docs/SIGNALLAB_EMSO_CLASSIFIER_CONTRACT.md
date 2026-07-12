# SignalLab EMSO measurement-hypothesis contract

Status: implemented experimental baseline
Model: `signal-lab-emso-bayes-v1`
Updated: 2026-07-11

## Purpose and claim boundary

Atomizer compares observed RF measurements with a closed set of SignalLab
synthetic hypotheses. This is an EMSO inference path: the classifier receives
only immutable scalar spectrum sweeps, a promoted `DetectedSignal`, and an
optional matching detected-power zero-span capture. It cannot read SignalLab
process state, selected profile, UI state, IPC, files, USB, or generator state.

The result is one of:

- `signal-lab:<profile>` when the available measurements strongly distinguish
  one synthetic profile;
- `signal-lab-family:<family>` when only a family-level synthetic hypothesis is
  defensible; or
- `unknown` with an explicit reason.

These labels do not establish standards conformance, protocol identity,
demodulation, symbols, EVM, phase, or I/Q behavior. A score is a posterior under
the declared expert generative model; it is not an empirically calibrated
probability of real-world identity.

## Pinned producer

| Field | Value |
|---|---|
| Producer | `tinysa-signal-lab` |
| Source commit | `942c8f7dfa3215c101c81a183a605ae924b306b1` |
| Catalog SHA-256 | `e7c953bd54f120528ebfce361bd306cd4bba2933ea052e9db5c59ab1901df39a` |
| Generator SHA-256 | `42cb108a9252f55856ea23712fd5908fe48675773e80ebd980a68b910be95897` |
| Preprocessing | `scalar-spectrum-envelope-features-v1` |
| Closed taxonomy | 79 profiles |

The taxonomy contains CW, AM, FM, GERAN/EDGE variants, LTE E-TM/sE-TM/N-TM,
5G NR FR1 TM/N-TM/SBFD variants, and Wi-Fi 6 HE variants. Catalog membership
defines hypotheses; it does not turn a standards-derived visual projection into
a conformance waveform.

## Evidence contract

Spectrum evidence requires at least three coherent complete sweeps. The model
derives occupied width, prominence, duty across sweeps, flatness, entropy,
texture, symmetry, center notch, peak density, peak drift, and power variation.
A matching zero-span capture adds detected-envelope range, deviation, duty,
transition rate, and dominant lag. GERAN, LTE, NR, and WLAN decisions require
both evidence views. Zero span remains detected power, never I/Q.

Every result retains source sweep IDs, optional zero-span capture ID, feature
values, model ID, producer hashes, qualification, score kind, and decision
level. Exact-profile, family, and unknown are distinct typed outcomes.

## Open-set and fail-loud behavior

The classifier returns `unknown` for:

- fewer than three coherent sweeps;
- a detection touching the acquisition boundary;
- no hypothesis covering the observed center/range;
- prominence below the model gate;
- gross absolute likelihood outside the pinned model domain;
- missing matching envelope evidence for a digital standards family; or
- insufficient posterior separation.

Ranked candidates may remain visible when the primary result is unknown. They
are diagnostic alternatives, not accepted identities. Inference exceptions are
surfaced; selected SignalLab state is never substituted.

Open-set rejection is required because closed-set automatic modulation
classifiers otherwise force unknown inputs into known classes. This design is
consistent with open-set waveform-classification literature such as
[Open-set recognition for common waveforms](https://arxiv.org/abs/2110.00252)
and [FSOS-AMC](https://arxiv.org/abs/2410.10265), while recognizing that those
methods commonly assume richer I/Q evidence than Atomizer possesses.

## Current validation statement

`npm run check:signal-classifier` builds an offline corpus from the sibling
SignalLab generator and passes it through the same detector and classifier used
by the application. The current deterministic AWGN fixture produces:

- 79/79 correct family decisions for known synthetic profiles;
- 4/79 exact-profile decisions, with the remainder conservatively family-level;
- 0 known-profile unknowns; and
- 11/12 generic survey emissions rejected as unknown; the remaining emission
  receives only an analog-family morphology hypothesis.

This validates contract wiring and synthetic-domain behavior. It is not a
physical-RF accuracy, calibration, false-alarm, or standards-conformance claim.
Those claims require session-grouped physical captures, held-out devices and
channels, per-class metrics, calibration error, coverage-risk curves, and an
explicit unknown corpus.

## Acceptance

- **EMSO-CLS-001:** no runtime SignalLab state appears in the classifier input.
- **EMSO-CLS-002:** all 79 catalog entries and producer hashes are closed and
  unique.
- **EMSO-CLS-003:** fewer than three sweeps returns `insufficient-evidence`.
- **EMSO-CLS-004:** an out-of-range center returns `out-of-domain`.
- **EMSO-CLS-005:** digital family decisions require a matching detected-power
  envelope.
- **EMSO-CLS-006:** generic open-set fixtures meet the frozen rejection gate.
- **EMSO-CLS-007:** scores are labeled model posterior, never calibrated
  real-world confidence.
- **EMSO-CLS-008:** exact/family results retain measurement and model provenance.
