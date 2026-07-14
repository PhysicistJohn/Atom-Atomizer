# SignalLab Bayesian observable-class contract

Status: implemented experimental synthetic baseline

Model: `bayesian-observable-equivalence-v5`

Updated: 2026-07-14

## Purpose and claim boundary

Atomizer performs Bayesian inference over observations that the tinySA actually
returns. The classifier receives only immutable scalar spectrum sweeps, a
promoted `DetectedSignal`, and an optional matching detected-power zero-span
capture. It cannot read the live SignalLab process, selected profile, UI state,
IPC, files, USB, generator state, or stimulus intent.

The result is a posterior over *observable evidence-equivalence classes*, not a
protocol decoder. A positive result means that the measured scalar evidence is
compatible with the named class under the pinned model. It does not establish
standards conformance, protocol identity, demodulated bits, modulation order,
EVM, phase, coding, cell identity, packet contents, or complex I/Q behavior.

The result qualification is `bayesian-observable-equivalence`, its decision
level is `equivalence-class` or `unknown`, and its score kind is
`model-posterior`. These are normalized class probabilities conditional on the
fixed synthetic empirical likelihoods, declared priors, hand-coded band context,
and observed features. They do not integrate uncertainty in fitted model
parameters and are not calibrated probabilities of physical-world identity.

## Taxonomy and deliberate ambiguity

The posterior denominator contains 12 leaves, including the unknown class:

| Evidence family | Diagnostic posterior leaves |
|---|---|
| Analog | CW-like; DSB full-carrier AM-like; FM/angle-modulated-like |
| Cellular | GSM/GERAN-like; LTE FDD-like; LTE TDD-like; 5G NR FDD-like; 5G NR TDD-like |
| Wi-Fi | HR-DSSS-like; OFDM-like |
| Bluetooth | Bluetooth-like band activity; Classic/LE mode unresolved |
| Open set | Unknown signal |

When the measurements do not distinguish sibling leaves, the decision is an
ancestor such as LTE-like, NR-like, or Wi-Fi-like. The two Wi-Fi leaf
posteriors are always diagnostic: the implemented primary Wi-Fi decision is
only `802.11-compatible channel morphology · PHY unresolved`. Scalar swept
power and fixed-tune detected power do not supply a decoded preamble,
DSSS/CCK correlation, cyclic-prefix measurement, or qualified
cyclostationarity, and the exact proprietary DSSS/OFDM nulls forbid treating
the result as 802.11 protocol or PHY identity. Bluetooth is modeled only as
Bluetooth-like band activity, with Classic/LE mode unresolved. LTE and NR
with nominal occupied bandwidth at or below 20 MHz are not identifiable from
these scalar views in the general case, especially under dynamic spectrum
sharing. Atomizer therefore returns `cellular-ofdm-ambiguous` in that domain
when the combined cellular posterior is sufficient. The implementation allows
measured widths through 25 MHz for a nominal 20 MHz channel because RBW and
threshold broadening are part of the observation.

FDD/TDD labels use soft band context and only qualified timing evidence within
the hard fitted-domain interval mask. The mask can reject an unsupported
observation but never selects a duplex leaf by itself. Wi-Fi OFDM generation, Bluetooth
LE PHY/coding, GSM GMSK versus EDGE modulation order, and BR/EDR modulation
order remain unresolved by scalar integrated power.

Bluetooth leaves require special restraint. Fixed-frequency tinySA zero span
cannot observe a link-wide Classic slot sequence or an LE advertising event
across three primary channels; it sees only visits or one packet at the tuned
channel. The current pipeline therefore admits only supporting scalar
spectrum/history band-activity evidence for Bluetooth. It must not use
an unconditioned or merely retagged `classic-slots` or
`ble-advertising-events` envelope. SignalLab synthesizes those captures
conditional on the recorded tune, yielding channel-local visits or packets,
not link-wide cadence. Without independently observed cross-channel evidence,
the primary result is Bluetooth-like band activity or `unknown`; the
Bluetooth-like posterior remains diagnostic when the primary result is unknown.

## Pinned model and corpus

| Field | Value |
|---|---|
| Producer | `tinysa-signal-lab` |
| Corpus | `observable-scalar-corpus-v7` |
| Corpus source commit | `03197cb5b4a03b85ef5efe6525f4f28ceedcaef3` |
| Corpus SHA-256 | `d813b3268eee7240a86b2de725ec78080dc0f3ce829fe0c493bf582b62f8529e` |
| Model asset SHA-256 | `bb4393e1e0e0e86977def9238a4e1e3dc03511f06b421384ff41316e37e96c9d` |
| Preprocessing | `scalar-observable-features-v5` |
| Prior | `engineering-design-class-weights-v1` |
| Calibration | `synthetic-view-matched-conformal-independent-attempt-min-support-detector-conditioned-physical-uncalibrated-v6` |
| Representative eligibility | `runtime-domain-qualified-known-representatives-v3` |
| Decision policy | `observable-open-set-decision-v9` |
| Canonical scenarios | 35: 17 known and 18 unknown/confuser |
| Fitted unknown scenarios | `unknown-narrow-fsk`, `unknown-802154` |
| Strict unknown holdouts | `unknown-chirp`, `unknown-impulsive` |
| Ambiguity validation only | Seven named scenarios below |
| Exact observable-equivalence nulls | Seven named scenarios below |
| Known acquisition validation only | `gsm-900-tdma` |
| Fitted examples | 8,140 detector-conditioned, fit-eligible first-ready production representatives |
| Generator-separated support calibration | 1,990 independent fit-eligible acquisition-attempt scores per evidence view |
| Student-t components | 18 |
| Posterior leaves | 12, including unknown |
| Feature dimensions | 28 |
| Minimum maximum-known synthetic support p-value | 0.025 |

The component-fit exclusion is the union of these immutable validation
partitions:

- strict unknown holdouts: `unknown-chirp`, `unknown-impulsive`;
- ambiguity validation only:
  `unknown-regular-cw-comb-4`, `unknown-regular-cw-comb-5`,
  `unknown-irregular-cw-multitone-100-210-370k`,
  `unknown-stationary-intermittent-2g4`,
  `unknown-simultaneous-1mhz-raster-2g4`,
  `unknown-interleaved-four-channel-2g4`, and
  `unknown-proprietary-off-raster-fhss-2g4`;
- exact observable-equivalence nulls:
  `unknown-instrument-spur-rbw-line`,
  `unknown-independent-am-equivalent-three-tone`,
  `unknown-independent-fm-equivalent-bessel-comb`,
  `unknown-generic-ofdm-20m`, `unknown-generic-tdd-ofdm-10m`,
  `unknown-generic-ofdm-80m`, and `unknown-proprietary-dsss-22m`; and
- known acquisition validation only: `gsm-900-tdma`.

The exact nulls are paired respectively with CW, AM, FM, LTE FDD 20 MHz, LTE
TDD 10 MHz, Wi-Fi OFDM 80 MHz, and Wi-Fi HR-DSSS projections. They deliberately
produce the same admitted scalar observables from an independent source story.
The validator must therefore require compatibility with the pair's declared
allowed evidence classes and forbid every disallowed acceptance; it must not
pretend that the scalar instrument can always force the primary result to
`unknown`.

The separate SignalLab repository also retains 79 visual stimulus profiles.
Those profiles are UI fixtures, not physical training truth and not the v5
posterior taxonomy. The v5 model is generated reproducibly from a pinned subset
of the immutable canonical scalar-observation corpus. Its scenarios are physics- or
standards-derived instrument projections; they are not conformance waveforms.

Corpus v7 evaluates spectrum power at the time each swept bin is visited.
GSM TDMA, LTE/NR TDD, and Wi-Fi CSMA traffic therefore gate the spectrum itself,
not only a later zero-span envelope. It separates one-timeslot
`gsm-900-tdma`, which is a finite-acquisition validation case, from the fitted
`gsm-900-loaded-bcch` carrier representing traffic/control/dummy-burst loading.
For AM and FM, zero span is a receiver-filtered detected-power projection:
modeled spectral components are coherently combined through the configured
Gaussian RBW response at the recorded tune. A local or off-center capture may
therefore be CW-compatible, as declared by the scenario, rather than being
forced to display an ideal baseband modulation envelope.

## Evidence and inference contract

The classifier requires at least eight coherent complete spectrum sweeps for an
accepted class. It extracts spectral extent and shape, history/hopping/raster
behavior, and, when qualified, detected-envelope timing features. The current
model uses finite mixtures of regularized empirical multivariate Student-t
likelihood components. Locations and covariance structure are plug-in estimates
from synthetic samples, degrees of freedom are fixed at 7, and regularization is
prescribed by the trainer. Missing dimensions use the exact fixed-component
marginal likelihood rather than a neutral value or negative class evidence.
This is not posterior-predictive integration over uncertain model parameters.

The class prior is explicit and independent of the number of scenarios or
legacy visual profiles. Adding fixtures to one family cannot increase that
family's prior. `unknown-signal` is a proper class in the same normalization as
all known leaves; it is not a threshold applied after a closed-class softmax.
Ranked results retain all 12 posterior leaves, including unknown, so their
reported probabilities remain auditable and sum to one.

Every scored inference result retains source sweep IDs, optional zero-span
capture ID, observed feature values, acquisition limitations,
model/corpus/asset hashes, prior ID, calibration ID, qualification, score kind,
and decision level. An early insufficient-evidence result may contain only the
available measurement provenance and explicit reason.

The detector freezes the classification frequency region and records its
originating sweep ID at first event admission. Track updates preserve that
region and origin record rather than recentering it, while appending only
independently re-detected sweep IDs to event evidence.

The provisional `frequency-agile-2g4-activity` path never mutates that frozen
emission region. Association model `frequency-agile-2g4-activity-v3` records a
strictly ordered stream of no-candidate, exactly-one eligible narrow candidate,
and ambiguous opportunities across the complete 2402--2480 MHz geometry. Every
positive observation retains its local detector evidence and track ID. Dynamics
model `bayesian-frequency-agile-transition-v2` compares declared agile and
stationary transition likelihoods conditional on positive unambiguous
observations. The agile side is an equal mixture of the fixed Beta-Binomial
Classic `Beta(78,1)` and LE `Beta(2,1)` marginals; the stationary side is the
predeclared fixed Bernoulli likelihood `p_change=0.05`, not an integrated
stationary Beta prior. The model requires at least eight positives in at least
three resolution cells and uses a maximum 96-opportunity window. Its promotion
and retention probabilities are
0.99 and 0.90. Occurrence probability deliberately cancels; the model does not
infer SNR or duty cycle from missing looks. The bounded association region,
opportunity outcomes, source sweeps, member IDs, and both model IDs remain
separate provenance. The extractor may consult them only for broad band-
activity features; they do not become a larger emission localization or an
emitter/link identity.

Exact dynamic programming over the sufficient transition counts gives a
sequential false-promotion probability of `1.3657385209e-5` through 96 positive
looks under the independent fixed-5% stationary null. That calculation omits
the independent minimum-three-resolution-cell guard, so it is a conservative
upper bound within the declared transition model. It is not a guarantee for
correlated receiver artifacts, nonstationary traffic, multiple emitters merged
by the provisional association, or physical tinySA operation.

`regular-spectral-component-activity` is a second classification-only
association. It records repeated same-sweep co-occurrence of at least three
independently detected narrow components compatible with one regular spacing.
Competing overlapping regular hypotheses or an independently detected
irregular interior component force abstention. Every member retains its local
track, detector evidence, frozen region, and expiry; group provenance records a
separate association ID, bounded group region, exact member-track IDs, source
sweeps, and `simultaneous-regular-components-v1` model ID. Association misses
and expiry are independent, so expiry removes only group evidence. The
classifier consumes exactly the latest eight admitted association looks. The UI
runs one classification for the association and maps that result to each member
row while continuing to label the selected line as a local detection. This is
not evidence that the components share an emitter.

Feature extraction uses only provenance-bound coherent sweeps
with matching frequency grid, RBW, attenuation, detector, gain state, device,
firmware, and execution identity. A zero-span capture must also match the target
detection and device identity. Every admitted source sweep contributes inside
the applicable provenance region for a fixed most-recent eight-admission
window; longer history is not pooled into look-count-dependent features. A
standard scenario provides 24 sequential opportunities, while a full-band 2.4
GHz scenario provides 96. There is no second 3 dB active-bin feature-admission gate. Local peak and cluster
thresholds are shape descriptors, not classifier entry criteria.

Wireless eligibility uses hard fitted-domain masks over the measured occupied
interval, not center frequency alone. The interval may receive only a bounded
RBW-scale edge allowance. A standards-compliant mode outside the bands or widths
represented in this pinned model is `unknown`; these masks describe model
support and do not redefine the standards.

## Timing qualification

Zero span is detected power versus time, never I/Q. Cadence-rate features,
including transition rate and periodic envelope energy, are used only when
`timingQualification` is `measured-calibrated` or
`simulation-exact`. Physical captures currently use `wall-clock-derived`
timing, so the classifier excludes their cadence features and records
`zero-span-timing-unqualified` rather than treating missing cadence as negative
evidence. The periodic-energy features are Fourier energies in a detected-power
history. They are not cyclostationarity or spectral-correlation estimators and
must not be presented as such.

Exact simulator timing does not make a link-wide Bluetooth envelope a valid
fixed-frequency capture. Classic slot cadence and aggregate LE advertising
event cadence are marginalized for Bluetooth decisions unless the evidence was
synthesized or measured conditional on the recorded tuned channel. The current
canonical corpus performs this frequency conditioning; retagging a
scenario-center envelope to a detector peak is forbidden. Even valid
channel-conditioned cadence is non-identifying supporting evidence and cannot
create or imply a Classic-like or LE-like mode decision.

Standard synthetic acquisitions offer 24 sequential 50 ms sweeps. Full-band
2.4 GHz acquisitions offer 96, equal to the agile model's maximum opportunity
window, and still require exactly eight admitted association looks for feature
extraction. The pinned BLE scenario explicitly versions its 20 ms advertising
interval and `packetSpacingSeconds=0.0015` within-event schedule; the acquisition
check evaluates those schedules rather than inventing unversioned cadence.
Across the final eight held-out event-phase seeds and three interstitial RBWs,
BLE acquired at one or more RBWs for 5/8 seeds at 24 dB and 8/8 at 32 dB. All
32 admitted BLE first-ready representatives returned Bluetooth-like band
activity. Non-admission is still reported as an acquisition outcome, not
negative evidence about BLE in general or a physical device.

The current UI requests a provisional 450 points over 50 ms. This request does
not prove a 9 ksample/s physical sampling rate: actual sample timing, analog
bandwidth, detector response, aliasing, and jitter have not been characterized.
A missing capture, tuning mismatch, partial-span boundary, sweep
time/frequency skew, aliased rate, or short window is retained as a limitation.

## Open-set and fail-loud behavior

The primary result is `unknown` when evidence is insufficient, the detection
touches the acquisition boundary, unknown posterior mass is too high, known
posterior mass is too low, no defensible leaf or aggregate clears the decision
rules, the model is unavailable, or inference fails. Frequency is soft context,
inside an eligible fitted domain, while wireless classes also enforce the hard
measured-interval support masks described above. Ineligible known hypotheses
receive zero structural support without removing `unknown` from normalization.

The unknown decision is intended for unsupported modulation, generic OFDM,
802.15.4, proprietary FHSS, chirps, collisions and mixtures, overload or
instrument artifacts, spurs, and ambient emissions. The fitted
`unknown-signal` likelihood currently contains only narrow FSK and the pinned
802.15.4-like projection. Strict holdouts, ambiguity stress, exact-equivalence
nulls, and one-timeslot GSM remain excluded under the immutable partition above.
The comb/multitone cases show why a regular association cannot establish common
emitter identity. The generic OFDM, DSSS, AM/FM-line, and spur pairs show why an
independent physical story cannot always be separated from a known evidence
class. Ranked candidates remain diagnostic alternatives when the primary
result is unknown; they are not accepted identities.

For each known class, generator-separated calibration converts the maximum
fixed-component radial-tail score to an inductive finite-sample rank support
p-value. Calibration v6 treats an acquisition attempt—not correlated local
fragments from that attempt—as the exchangeable unit. For each known class and
view it stores one conservative score per fit-eligible attempt: the minimum
known-class support over that attempt's first-ready eligible representatives.
The final asset contains 1,990 independent attempt-level scores in each of the
`spectrum-only`, `envelope-untimed`, and `envelope-timed` views, distributed
across their originating known classes. Inference selects the matching view,
takes the maximum class-conditional support p-value across eligible known
classes, and rejects below 0.025. A support rejection
must report primary label `unknown`, confidence zero, and explicit
`synthetic-support-p-value` value and threshold. Ranked candidate model
posteriors remain available as diagnostic alternatives but are not the primary
confidence or an accepted identity. Nominal 2.5% support coverage is
conditional on exchangeability with the pinned SignalLab synthetic calibration
generator under the same evidence view. It is not posterior-predictive
parameter integration, physical receiver calibration, or a guarantee for
ambient RF.

Training and regression validation use the production
`bayesian-exponential-multiscale-cfar-v3` detector and two-state tracker, not a
known-presence or max-hold extractor. Each example supplies 24 sequential
observation opportunities, or 96 for full-band 2.4 GHz association scenarios;
fitting, calibration, and classification consume exactly the latest eight
admitted local or association sweeps. Admission misses
are reported separately from classification conditional on admission. The
tracker's `frequency-agile-2g4-activity-v3`, its
`bayesian-frequency-agile-transition-v2` dynamics evidence, and
`simultaneous-regular-components-v1` associations participate with their actual
runtime provenance and expiry behavior. This is end-to-end synthetic
detector/tracker/classifier regression, but it remains shared-generator
development evidence rather than physical validation.

## Current validation statement

The held-out nuisance-shift validator uses unseen seeds `13001`, `13019`,
`13037`, `13063`, `13081`, `13099`, `13127`, and `13151`; SNR values
6/10/16/24/32 dB; interstitial RBW divisors 15.5/44/98; standard 24- and
full-band 2.4 GHz 96-opportunity horizons; and an exact eight-admission
classification window. It independently pins and audits the fitted, strict
holdout, ambiguity-only, exact-equivalence, and known-acquisition-only
partitions so regenerated metadata cannot silently move a case. It reports
admission separately from conditional classification and computes proper
scores only on singleton-truth, fit-eligible examples.

The final regression ran 4,200 acquisition attempts. It admitted 2,145
attempts (0.510714) and produced 9,944 unique first-ready representatives.
Conditional hierarchical accuracy was 0.985318, known coverage 0.993796,
covered-known hierarchical accuracy 1.0, known top-leaf accuracy 0.993996,
and the minimum high-SNR known-class hierarchical accuracy was 0.9875. On
5,525 singleton-truth proper-score samples, fitted-template log loss was
0.0142141, multiclass Brier score 0.00825527, and ECE 0.00192381. Fitted-unknown
AUROC and rejection were both 1.0; scenario-excluded strict-typicality AUROC
was 0.997999 and admitted strict-holdout rejection was 1.0.

All 840 exact-equivalence nuisance cells yielded 2,278 matched representative
pairs and 4,556 matched evidence-view pairs with zero discrepancies at
`1e-11` tolerance. Exact-equivalence compatibility was 1.0, and both the
unknown false-accept count and disallowed false-accept attempt count were zero.
These figures are read from `.artifacts/classifier-validation/report.json`.

Acceptance requires every admitted strict holdout to return `unknown`, every
ambiguity or exact-equivalence case to remain inside its declared compatible
class set, and zero disallowed false acceptances. The chirp and one-timeslot GSM
are the only pinned expected classification non-admissions; this exception list
cannot expand from model output. Nominal LTE/NR cases at or below 20 MHz must
retain the deliberate cellular-OFDM ambiguity whenever no qualified
distinguishing observation exists. A leaf mismatch is not automatically a
model failure when the documented evidence-equivalence ancestor is the
scientifically correct decision.

These metrics establish deterministic implementation and held-out synthetic
behavior only. The synthetic cases share a generator and instrument projection
with training; they are not independent physical RF sessions. They do not
establish real-world calibration, prevalence, false-accept rate, standards
conformance, or robustness across devices, firmware, gain states, detectors,
interference, fading, and environments. Those claims require a frozen model and
session/device-grouped physical captures with an explicit physical open set.

The upstream Bayesian detector is likewise experimental. Its multiscale
predictive-tail gate has an ideal-model multiplicity adjustment, but it is not
an achieved tinySA per-sweep or per-hour false-alarm probability. Production-path
synthetic regression does not validate physical detection.

## Acceptance

- **EMSO-CLS-001:** runtime SignalLab state never appears in classifier input.
- **EMSO-CLS-002:** corpus, model asset, preprocessing, prior, and calibration
  identifiers are immutable result provenance.
- **EMSO-CLS-003:** fewer than eight coherent sweeps returns
  `insufficient-evidence`.
- **EMSO-CLS-004:** a boundary-censored event returns `out-of-domain`.
- **EMSO-CLS-005:** missing or unqualified timing features are marginalized,
  never converted into negative class evidence.
- **EMSO-CLS-006:** unknown participates in the same posterior denominator as
  every known leaf.
- **EMSO-CLS-007:** nominal LTE/NR observations at or below 20 MHz preserve the
  documented cellular-OFDM ambiguity.
- **EMSO-CLS-008:** scores are labeled synthetic-model posterior, never
  physically calibrated confidence.
- **EMSO-CLS-009:** every scored result retains measurement limitations and
  model provenance; early unavailable results retain the available evidence and
  reason.
- **EMSO-CLS-010:** physical identity or protocol claims remain gated on
  configuration-matched, session-grouped physical validation.
- **EMSO-CLS-011:** fixed-frequency zero span never supplies link-wide
  Bluetooth Classic slot or multi-channel LE advertising-event evidence;
  Classic/LE mode leaves are not exposed, and the accepted result is limited to
  Bluetooth-like band activity or `unknown`.
- **EMSO-CLS-012:** a frequency-agile 2.4 GHz association retains a separate
  bounded association region and source-sweep provenance; it never mutates the
  detector-frozen first-admission emission region.
- **EMSO-CLS-013:** a regular-component association is classification-only,
  abstains on ambiguous membership, expires independently, retains local and
  group provenance, uses exactly eight admitted association looks, produces one
  UI classification per group, and never asserts common-emitter identity.
- **EMSO-CLS-014:** wireless hard eligibility masks test the measured occupied
  interval rather than center frequency alone; observations outside the fitted
  model domain return `unknown` without redefining the underlying standard.
- **EMSO-CLS-015:** Full-band 2.4 GHz scenarios use the declared 96-opportunity
  horizon; BLE non-admission is reported separately and never converted into a
  negative protocol observation.
- **EMSO-CLS-016:** fitted unknowns, strict holdouts, ambiguity-only cases,
  exact-equivalence nulls, and known acquisition-only scenarios remain separate
  immutable partitions in model provenance and validation reports.
- **EMSO-CLS-017:** exact-equivalence and ambiguity cases may resolve only to a
  declared compatible evidence class or `unknown`; no UI or metric invents a
  uniquely identifiable source story.
- **EMSO-CLS-018:** HR-DSSS-like and OFDM-like Wi-Fi leaf posteriors are
  diagnostic only. The primary result is `802.11-compatible channel morphology
  · PHY unresolved` or `unknown`, never a protocol or PHY identity.
