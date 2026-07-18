# SignalLab Bayesian observable-class contract

Status: implemented experimental synthetic baseline

Model: `bayesian-observable-equivalence-v8`

Updated: 2026-07-15

Normative specifications, original papers, and the limits inferred from them
are pinned in [the Bayesian detection and classification research
basis](./BAYESIAN_DETECTION_CLASSIFICATION_RESEARCH.md).

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
fixed synthetic empirical likelihoods, declared priors, the observed features,
and the structural support mask `standards-operating-band-context-v1`. That
versioned table pins specification revisions, clauses, source URLs, and source
document hashes for TS 45.005 19.0.0, TS 36.101 18.5.0, and TS 38.104 18.12.0.
It is not a likelihood, survey prior, deployment database, protocol observation,
or regulatory authorization. The probabilities do not integrate uncertainty in
fitted model parameters and are not calibrated probabilities of physical-world
identity.

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

FDD/TDD leaves are eligible only when the complete measured occupied interval,
with a bounded RBW edge tolerance, fits a corresponding FDD or TDD link range
in `standards-operating-band-context-v1`. This is a hard structural support
mask, not soft frequency evidence: it can reject an unsupported leaf but never
selects a duplex leaf by itself. Wi-Fi OFDM generation, Bluetooth
LE PHY/coding, GSM GMSK versus EDGE modulation order, and BR/EDR modulation
order remain unresolved by scalar integrated power.

The primary-decision policy never promotes an FDD leaf because absence of a
TDD-like cadence is not positive FDD evidence. It can promote an LTE-TDD-like
or NR-TDD-like leaf only when qualified detected-envelope timing supplies a
transition-rate feature and the leaf clears the posterior and sibling-margin
gates. Otherwise the primary result collapses to LTE-like, NR-like, or
cellular-OFDM-ambiguous; all FDD/TDD leaf posteriors remain diagnostic. Above
25 MHz, `nr-like` is an NR-compatible wideband-OFDM morphology claim, not
decoded NR identity.

The output ontology does not include supplementary-only operation. The
standards table keeps SDL and SUL rows explicit: a supplemental row alone does
not support either fitted FDD or TDD leaf. When an SDL/SUL range overlaps a
paired or shared row, every compatible mode remains present rather than being
silently relabeled, and other evidence must resolve or preserve the ambiguity.
Frequency alone does not establish which standardized mode, deployment, or
transmitter produced the emission.

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

LE 1M and LE Coded share 1 Msym/s shaped-binary-FM spectral occupancy closely
enough that this scalar instrument does not separate them. They are not
described as physically power-equivalent: coding, packet format, and duration
differ, while unknown payload/event context and uncalibrated timing make one
detected-power capture non-identifying.

## Pinned model and corpus

The table below records the independently regenerated v19 model, its exact
training matrix, and the policies enforced by the release validator.

| Field | Value |
|---|---|
| Producer | `tinysa-signal-lab` |
| Corpus | `observable-scalar-corpus-v13` |
| Corpus source commit | `03bc13eb9d5efcfc5f2f9c1792042f670b71ef9a` |
| Canonical source-manifest SHA-256 | `38288f0e0437dbb687674308afecb4f30adadc9e93ea7abad3b8bf13d80ec918` over the complete executed TypeScript import closure plus package dependency semantics; generation/validation also require a clean SignalLab index and worktree |
| Source artifact SHA-256 values, lexical path order | `package-lock.json`: `5b9b9620ee2667aab2ef18eb12514557511d9be20b9eff5e06a54ed213c4a6b0`; `package.json`: `e278e52ed74d12e959f02666fc64cad6a372bdc1e9551bf1317d341f663b440f`; `src/canonical-timing.ts`: `6537edce440fe5ea11dc87e72cf8bd270bb77b6990bcf10b2443a2ddceb67b21`; `src/catalog.ts`: `24575b0a0c73853abb52e245a567d96d3cca835a48217619f6e105235519989a`; `src/classification-corpus.ts`: `220a83afe368c2ad7baffd305945e413a3e4e5e9d6feadac26065a0add2c3d09`; `src/contracts.ts`: `37c38eddb62c345dfa41e9d53ea327030123e804ab74b152e439dcd8c7df6daa`; `src/source-provenance.ts`: `4dd372449fedf70b69f1e9f2250598767e057abb3d5ceeab5373126146b2f7df`; `src/waveforms.ts`: `1af5cf7dd59fab899332192df7ae77b13aabd482b3050ee685a7c4d559978584` |
| Model asset SHA-256 | `6e25efced19690b599745000fe6b0ea46ca1af67220bb3b2b3b691b9bcf2ffe4` |
| Training runtime identity | `exact-repository-node-version-v1`: Node `22.23.1`, V8 `12.4.254.21-node.56`; the launcher must read `.node-version` and reject before private build unless its own `process.version` is exactly `v22.23.1`, the executed private trainer must independently verify the attested identity, and the training matrix plus validation acceptance/report must carry it; npm `10.9.8` is a separate developer/CI tooling pin |
| Cellular operating-band context | `standards-operating-band-context-v1`: 147 rows (14 GERAN, 67 E-UTRA, 66 NR FR1); TS 45.005 19.0.0, TS 36.101 18.5.0, TS 38.104 18.12.0 |
| Preprocessing | `scalar-observable-features-v7` |
| Prior | `engineering-design-class-weights-v1` |
| Calibration | `synthetic-independent-branch-view-matched-causal-acquisition-support-rank-detector-conditioned-physical-uncalibrated-v19` |
| Support-rank score unit | `one-independent-branch-acquisition-attempt-score-per-evidence-view-v4` |
| Support-rank representative selection | `consecutive-spectrum-all-runtime-representatives-and-independent-qualified-envelope-sole-capture-v4` |
| Support-rank attempt aggregation | `consecutive-spectrum-branch-minimum-qualified-envelope-branch-sole-capture-v5` |
| Support-rank runtime interpretation | `spectrum-member-dominates-independent-branch-attempt-min-envelope-is-independent-sole-capture-v3` |
| Support-rank sampling claim | `empirical-synthetic-reference-only-no-exchangeability-or-coverage-guarantee-v1` |
| Representative eligibility | `observation-only-hypothesis-domain-v5` |
| Decision policy | `observable-open-set-decision-v10` |
| Canonical scenarios | 35: 17 known and 18 unknown/confuser |
| Fitted unknown scenarios | `unknown-narrow-fsk`, `unknown-802154` |
| Strict unknown holdout | `unknown-impulsive` |
| Ambiguity validation only | Eight named scenarios below, including `unknown-chirp` |
| Exact observable-equivalence nulls | Seven named scenarios below |
| Known acquisition validation only | `gsm-900-tdma` |
| Fitted examples | 158,657 detector-conditioned, observation-domain-eligible production representatives: 148,327 spectrum-only, 5,165 envelope-untimed, and 5,165 envelope-timed |
| Generator-separated support reference | Exact per-scenario/per-view independent-branch attempt counts published by the generated training matrix and reconciled validation report |
| Source scenarios / likelihood components | Spectrum 18 / 28; envelope untimed 16 / 26; envelope timed 16 / 26 |
| Posterior leaves | 12, including unknown |
| Feature dimensions | 28 |
| Minimum maximum-known synthetic support rank | 0.025 engineering cutoff |

The checked-in v8 likelihood architecture has 28 ordered feature dimensions and 12 exact leaf class IDs. Its spectrum-only population has 18 source scenarios and 28 likelihood components; each envelope population has 16 scenarios and 26 components because the Bluetooth-like class is structurally unsupported for fixed-tune envelope evidence. Under scenario-components-with-three-shared-covariance-csma-activity-modes-v1, exactly five pinned CSMA sources use three deterministic activity modes while every other supported source/view pair uses one component; source scenarios retain equal within-class mass, CSMA modes use empirical within-source weights, and each decomposed source shares one pooled within-mode covariance. Under frequency-agile-fixed-tune-envelope-censoring-v1, the analysis boundary validates the physical capture and schema-4 receipt first, including its canonical SHA-256 binding of all returned samples, cadence, requested geometry, RF metadata, and provenance, then excludes detected-power envelope features for every frequency-agile association and classifies its exact regional spectrum/history view. This censor is triggered by observed association geometry, never a truth label or requested hypothesis; Bluetooth envelope component and calibration arrays are therefore exactly empty.

Production inference does not use missing-dimension marginalization: v8 selects one exact evidence view, requires its complete finite feature set with no extras, and evaluates only the independently fitted spectrum-only, envelope-untimed, or envelope-timed likelihood population.

Representative-eligibility policy v5 admits the FM leaf only when the scalar
observation has resolved sidebands (`spectrum.sidebandScore >= 0.2`) or a
materially modulated detected-power envelope (`envelope.rangeDb >= 2` and
`envelope.standardDeviationDb >= 0.5`). An unresolved finite FM view remains
CW-like or `unknown`. This is a model-support gate, not a universal FM
definition or a claim that every FM signal will resolve in the admitted view.

The open-set rejection cutoff is a minimum maximum-known synthetic support rank of 0.025; it is an engineering threshold, not a p-value or coverage guarantee.

The completed v19 release evidence satisfies the acquisition contract below.
The fitted and independently regenerated acquisition matrix uses SignalLab's 450-point recommended-span grid in two independent production-gate sessions under independent-no-auto-spectrum-and-qualified-rank-0-integrated-excess-envelope-sessions-v2. The no-automatic-capture consecutive-spectrum branch starts its twelve profiles at source looks 0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, and 416 and spans source indices [0, 512); the qualified-envelope branch starts them at source looks 0, 33, 66, 99, 132, 165, 198, 231, 264, 297, 330, and 427 and spans [0, 524), with at most one detected-power capture after rank-0 runtime admission. Under preferred-then-current-source-sweep-integrated-excess-power-physical-or-qualified-agile-member-target-v4, ordinary targets are active physical rows with zero missed sweeps. The only candidate-state exception is the exact latest raw detector/track member cited by the latest exactly-one opportunity of a current, promotion-qualified, zero-miss frequency-agile association. The synthetic activity summary never owns the hardware capture, and arbitrary candidates, stale members, retained summaries, and ambiguous opportunities remain ineligible. An autonomous branch ranks eligible raw rows by current-source-sweep integrated excess power under current-source-sweep-integrated-excess-power-v1; it integrates positive linear power above the robust floor over complete physical cells and normalizes by actual RBW. The stable representative key and raw ID are exact-power tie-breaks. Association qualification controls only whether the narrow agile projection exists, never priority among eligible rows. Truth labels, class-domain eligibility, feature readiness, and classifier posteriors never influence that ranking. After ranking, the controller tunes and binds the capture to the raw row while receipt schema 4 projects the exact eight-sweep classifier window to its evidence representative and binds the complete returned capture with domain-separated canonical SHA-256. For an agile projection the receiver remains fixed on the selected physical channel and may observe later returns or no return; it never follows the hop and proves neither a common emitter nor Bluetooth protocol or mode identity. Under frequency-agile-fixed-tune-envelope-censoring-v1 the valid capture and receipt remain audited, but every frequency-agile fixed-tune envelope is excluded from classifier features and the exact regional spectrum/history view is used; this observation-geometry censor is independent of truth or requested hypothesis. Later spectra continue at the next source look. Held-out validation begins at source look 512 for consecutive spectrum and 524 for qualified envelope. Every envelope admitted to a classifier likelihood requires an analysis-issued capture receipt and is explicitly qualified as receipt-verified-provenance-bound-runtime-admitted-physical-capture-v5; receipt-free or runtime-unadmitted captures cannot enter Bayesian envelope metrics. Public detected-power synthesis uses the generator-internal 100 kHz filter; measured detected-power RBW remains unavailable and is never classifier evidence.

The schema-4 receipt is minted only by the analysis boundary after independent replay and candidate ranking, is deeply frozen and process-authorized, and is revalidated against the representative, admitted tune, ordered eight-sweep window, and domain-separated SHA-256 of the complete canonical returned capture before envelope features are admitted. That payload digest covers every power sample, cadence and requested-geometry/control field, RF metadata/qualification, source field, and provenance field; an authorized receipt cannot be replayed with a substituted finite payload. Issuance rejects root or nested Proxy graphs and retains a deeply frozen structured-clone snapshot; after verification, feature extraction consumes only that authority-owned snapshot, never the caller-owned graph, preventing hash/read TOCTOU substitution.

`zero-span-capture-canonical-json-v1` accepts only the exact strict typed graph made of plain objects and ordinary dense arrays with enumerable own data fields. It recursively sorts object keys, preserves array order, uses JSON encoding for finite numbers, strings, booleans, and null, and treats an omitted optional field and an own optional field whose value is `undefined` as the same typed absence. It rejects non-finite numbers, holes, decorated or subclassed arrays, accessors, symbols, cycles, extra root fields, and missing/non-enumerable required fields. SHA-256 is computed over the UTF-8 bytes of `tinysa-detected-power-capture-payload-v1\0` followed by that canonical JSON.

The App zero-span action enters a Bayesian envelope view only when the capture is bound to an analysis-issued receipt for a current runtime-admitted target, exact admitted tune, and exact eight-sweep evidence window. Receipt qualification is necessary but not sufficient: under frequency-agile-fixed-tune-envelope-censoring-v1, every fixed-tune frequency-agile capture remains excluded from Bayesian envelope inference and the exact spectrum view is used instead. Any other receipt-free or runtime-unadmitted capture may feed only the separate envelope heuristic.

The component-fit exclusion is the union of these immutable validation
partitions:

- strict unknown holdout: `unknown-impulsive`;
- ambiguity validation only:
  `unknown-chirp`, `unknown-regular-cw-comb-4`,
  `unknown-regular-cw-comb-5`,
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

`unknown-chirp` is likewise ambiguity validation rather than a strict unknown
holdout: finite local detector/tracker fragments may be CW-like or FM-like, so
its only defensible accepted set is CW-like, FM-like, or `unknown`.

The separate SignalLab repository exposes a 34-profile closed catalog. Twelve
public observable profiles share the corpus's executable known-scenario source;
the other 22 visual/standards profiles remain stimulus fixtures.
Those profiles are UI fixtures, not physical training truth and not the v8
posterior taxonomy. Named test models whose required allocation, PRB sequence,
timing, or spectral partition is not implemented are excluded from selection;
their absence is unsupported capability, not negative family evidence. The v8
model is generated reproducibly from a pinned subset
of the immutable canonical scalar-observation corpus. Its scenarios are physics- or
standards-derived instrument projections; they are not conformance waveforms.
The eight-file manifest includes the six-file relative TypeScript import closure
rooted at `src/classification-corpus.ts`, including
`src/canonical-timing.ts`, and the package manifest/lockfile that pin executed
dependency semantics. Both generation and validation fail on a
dirty SignalLab tree, an untracked file, a symlink/non-regular artifact, an
untracked manifest path, a worktree/blob difference, or a changed import closure.

The scenario corpus and the operating-band support table are separate assets.
“Standards-derived scenario” remains limited to the cited instrument projection
and is not a conformance-waveform claim. The independent
`standards-operating-band-context-v1` table transcribes the pinned GERAN,
E-UTRA, and NR FR1 operating-band rows: 14, 67, and 66 rows respectively. It
preserves FDD, TDD, SDL, and SUL overlap and supplies structural interval
compatibility only; it does not prove
protocol identity, actual deployment, paired-channel activity, or regulatory
authorization.

Wi-Fi is not part of that cellular standards table. Its separate structural
model-support masks
admit HR-DSSS-like observations only in 2.4--2.5 GHz at 10--30 MHz measured
width, and OFDM-like observations in 2.4--2.5, 4.9--5.925, or 5.925--7.125 GHz
at 8--110 MHz measured width. A fully observed 160/320 MHz channel exceeds that
supported width, while resource-unit allocation and puncturing are not represented;
those cases remain unsupported or unresolved.
Only 2.4 GHz Wi-Fi centers are present in the fitted corpus. The 5/6 GHz mask is
therefore standards-context extrapolation, not evidence that its likelihood was
empirically fitted throughout those bands. Likewise, the broad GERAN/E-UTRA/NR
band tables extrapolate structural eligibility beyond the fitted Band 3,
Band 38, n3, and n78 centers. Both require representative physical validation
before any field-performance claim.

Corpus v13 evaluates spectrum power at the time each swept bin is visited.
The deterministic fixed-slot-0 one-of-eight GSM envelope, fully selected LTE
TDD configuration, standards-valid NR 7-DL/3-UL engineering schedule, and
seeded CSMA-like Wi-Fi engineering envelope therefore gate the spectrum itself,
not only a later zero-span envelope. These scalar schedules are not decoded MAC
traffic or protocol likelihoods. The corpus separates the `gsm-900-tdma`
fixed-slot-0 finite-acquisition stress case from the fitted
`gsm-900-loaded-bcch` engineering loaded-downlink replay. The latter uses
continuous slot occupancy and synthetic texture representing traffic, control,
or dummy bursts; that texture is not a decoded GMSK burst sequence and neither
implies every GSM carrier is continuous nor provides protocol likelihood.
For AM and FM, zero span is a receiver-filtered detected-power projection:
modeled spectral components are coherently combined through an explicit
generator-internal synthesis filter at the recorded tune. Public production
replay pins that filter to 100 kHz but does not publish it as measured or
calibrated detected-power RBW. A local or off-center capture may therefore be
CW-compatible, as declared by the scenario, rather than being forced to
display an ideal baseband modulation envelope.

Corpus v13 retains, rather than infers, three non-universal timing configurations:

- The downlink-only Band 38 LTE TDD scenario uses
  `lte-tdd-config0-ssp7-normal-cp-downlink-v1`: UL/DL configuration 0
  (`DSUUUDSUUU`), normal cyclic prefixes, special-subframe configuration 7, and
  absent `srs-UpPtsAdd` (`X=0`). At
  \(T_s=1/30{,}720{,}000\) s, DwPTS is 21,952 \(T_s\) (714.583333
  microseconds), GP is 4,384 \(T_s\) (142.708333 microseconds), and UpPTS is
  4,384 \(T_s\) (142.708333 microseconds). Only full-DL subframes and DwPTS are
  active, for exact downlink duty 0.3429166667; GP and UpPTS are inactive. SSP 7
  is a SignalLab scenario choice, not implied by Band 38 or configuration 0.
  The normative basis is [3GPP TS 36.211 19.3.0 clause 4.2 and Tables 4.2-1/
  4.2-2](https://www.etsi.org/deliver/etsi_ts/136200_136299/136211/19.03.00_60/ts_136211v190300p.pdf).
- The downlink-only n78 scenario uses
  `nr-tdd-7dl-3ul-engineering-v1`: one valid 5 ms, 30 kHz-SCS
  `TDD-UL-DL-Pattern` with seven complete DL then three complete UL slots and no
  mixed/flexible symbols. It is not implied by n78 or universal deployment
  behavior. Its normative basis is [3GPP TS 38.331 19.1.0 clause
  6.3.2](https://www.etsi.org/deliver/etsi_ts/138300_138399/138331/19.01.00_60/ts_138331v190100p.pdf)
  and [3GPP TS 38.213 19.3.0 clause
  11.1](https://www.etsi.org/deliver/etsi_ts/138200_138299/138213/19.03.00_60/ts_138213v190300p.pdf).
- The BLE primary-advertising scenario uses
  `ble-primary-advertising-engineering-v1`: all three 2402/2426/2480 MHz primary
  centers in sequential 37-to-38-to-39 order, 1.5 ms packet-start spacing, 376
  microsecond packet duration, a 20 ms interval, and deterministic seeded
  per-event pseudorandom `advDelay` in `[0,10 ms)`. Observation provenance
  records the seed. The sequence is standards-consistent for the modeled legacy
  all-three-channel event; configured subsets, early event closure, and extended
  advertising differ. The all-three use, spacing, duration, interval, and
  deterministic delay generator are engineering choices, not universal
  Bluetooth traffic or PDU behavior. The 80 MHz field is the aggregate
  primary-channel support span, not instantaneous occupied bandwidth. The
  normative boundary is [Bluetooth Core 6.3, LE Link Layer
  clauses 2.3.1 and
  4.4.2](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Core_v6.3/out/en/low-energy-controller/link-layer-specification.html).

The v13 n3 `carrierRasterHz` is the ordinary band-specific 100 kHz channel
raster, distinct from the 5 kHz global-raster NR-ARFCN step applicable in n3's
frequency range and documented by [3GPP TS 38.104 19.4.0 clause
5.4.2.3](https://www.etsi.org/deliver/etsi_ts/138100_138199/138104/19.04.00_60/ts_138104v190400p.pdf).
The v13 n78 scenarios use the exact 3,500,010,000 Hz carrier center, NREF
633334, on the selected 30 kHz band-specific channel raster. That raster is
distinct from the 15 kHz global NR-ARFCN step in this frequency range.

## Evidence and inference contract

The classifier requires at least eight coherent complete spectrum sweeps for an
accepted class. It extracts spectral extent and shape, history/hopping/raster
behavior, and, when qualified, detected-envelope timing features. The current
model uses finite mixtures of regularized empirical multivariate Student-t
likelihood components. Locations and covariance structure are plug-in estimates
from synthetic samples, degrees of freedom are fixed at 7, and regularization is
prescribed by the trainer. An unavailable envelope selects `spectrum-only`; a
qualified envelope without fully qualified cadence selects `envelope-untimed`;
and fully qualified timing selects `envelope-timed`. Each selected view supplies
its exact complete fitted dimension set. Production neither marginalizes an
arbitrary subset of a component nor imputes a missing feature.
This is not posterior-predictive integration over uncertain model parameters.

The class prior is explicit and independent of the number of scenarios or
legacy visual profiles. Adding fixtures to one family cannot increase that
family's prior. `unknown-signal` is a proper class in the same normalization as
all known leaves; it is not a threshold applied after a closed-class softmax.
Ranked results retain all 12 posterior leaves, including unknown, so their
reported probabilities remain auditable and sum to one.
`engineering-design-class-weights-v1` is a design assumption, not a prevalence
estimate. The validator applies declared unknown-mass shifts and family-mass
shifts that preserve known-class or within-family ratios, then gates known
coverage, hierarchical accuracy, incompatible non-unknown risk, unknown false
acceptance, and decision-change rate. This deterministic synthetic sensitivity
does not calibrate operational priors; representative physical survey
prevalence remains an explicit non-release field-validation limitation.

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
model `bayesian-frequency-agile-transition-v3` compares declared agile and
stationary transition likelihoods conditional on positive unambiguous
observations. The agile side is an equal mixture of two engineering Beta-
Binomial components: `fullBand79CellChangePrior = Beta(78,1)` and
`threePrimaryChannelChangePrior = Beta(2,1)`. These neutral names describe a
79-cell full-band-agile family and a three-primary-channel-agile family;
neither is a Bluetooth Classic/LE protocol or emitter likelihood. BR/EDR
adaptive frequency hopping may use and remap 20--79 usable channels, and LE
connection and secondary-channel maps contain 2--37 used general-purpose
channels. Channel selection, advertising-event order, packet occupancy, and
receiver censoring violate an iid transition interpretation. The stationary
side is the predeclared fixed Bernoulli likelihood `p_change=0.05`, not an
integrated stationary Beta prior. The model requires at least eight positives
in at least three resolution cells and uses a maximum 96-opportunity window. Its
promotion and retention probabilities are
0.99 and 0.90. Occurrence probability deliberately cancels; the model does not
infer SNR or duty cycle from missing looks. The bounded association region,
opportunity outcomes, source sweeps, member IDs, and both model IDs remain
separate provenance. The extractor may consult them only for broad band-
activity features; they do not become a larger emission localization or an
emitter/link identity.

The evidence contract exposes
`fullBand79CellAgileLogMarginalLikelihood`,
`threePrimaryChannelAgileLogMarginalLikelihood`, and
`primaryChannelCenterHitCount`. The two marginals use only transition counts;
the primary-center hit count is retained as diagnostic provenance and does not
turn either engineering family into advertising-event or protocol evidence.

The transition Bayes factor does not use primary-center hits. The classifier
separately includes `history.bleAdvertisingScore`, an accumulated regional
three-primary-center morphology score. It may affect
Bluetooth-compatible-versus-unknown likelihood, but it cannot establish
Bluetooth protocol, LE mode, or an advertising event; proprietary
three-channel activity is observationally compatible with it.

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
track, detector evidence, frozen region, and expiry. Group provenance records a
stable allocated association ID plus exact per-look member-track IDs, current
hull, spacing, lattice anchor, and immutable source sweep under
`regular-spectral-component-lineage-v2`. A lineage survives member-track churn
only while successive exact looks share a compatible lattice, overlapping
observed support, and at least one resolved component center; its public
members and region always describe the latest
look. Every cited sweep is independently replayed. Association misses and
expiry are independent, so expiry removes only group evidence. The
classifier consumes exactly the latest eight admitted association looks. The UI
runs one classification for the association and maps that result to each member
row while continuing to label the selected line as a local detection. This is
not evidence that the components share an emitter.

`multicomponent-swept-region-activity` is the third classification-only
association. `multicomponent-swept-region-v2` requires at least four members,
each independently admitted by `bayesian-exponential-multiscale-cfar-v3` with
complete selected-local-region Bayesian evidence. It admits a current look only
when either a member's selected multiscale classification region contains the
complete observed member hull within `1.1 × max(RBW, bin width)` tolerance
(`selected-multiscale-region-containment-not-emitter-identity`), or the resolved
members satisfy the model's bounded 1-to-3-step raster and edge-exception rules
(`resolved-component-raster-not-emitter-identity`).

The association's public region is exactly the latest current observed hull,
and its public member-track list is exactly the latest current membership. They
are not cumulative unions. History is capped at the classifier's latest exact
eight observations and retains only identical sweep geometry, regions whose
padding by `max(2 × RBW, 5 × bin width)` has intersection-over-union at least
0.75 with the new/latest region, and at least one component center shared
within that same tolerance. Incompatible geometry, region, or component
history is pruned. Each retained observation keeps its then-current member
list, while current membership is replaced by the latest list. A lineage may
reconnect only while its miss count remains within the tracker release window;
missed evidence is not currently classification-qualified, and reacquisition
after expiry receives a new association ID. Local tracks keep their
independent detector evidence and persistence. A zero-span capture remains
bound to the selected local member and tune; it is not evidence spanning the
regional hull. This association claims neither simultaneity, a common process,
nor emitter identity.

Feature extraction uses only provenance-bound coherent sweeps
with matching frequency grid, RBW, attenuation, detector, gain state, device,
firmware, and execution identity. A zero-span capture must also match the target
detection and device identity. Detector centroids may be fractional, so the
shared detected-power tune projection selects the nearest point on the
advertised integer-Hz lattice (higher on an exact tie), rejects non-finite or
out-of-range values, and records the same projected value in synthesis, the
admitted request, capture frequency, and classifier provenance. Candidate
selection clears a differently bound envelope and stages this projected tune;
the separately invoked capture remains the only acquisition action. Every admitted source sweep contributes inside
the applicable provenance region for a fixed most-recent eight-admission
window; longer history is not pooled into look-count-dependent features. A
trainer, tail-calibration, or held-out-validation standard scenario provides
32 sequential opportunities; a full-band 2.4 GHz scenario provides 96. There
is no second 3 dB active-bin feature-admission gate. Local peak and cluster
thresholds are shape descriptors, not classifier entry criteria.

Wireless eligibility uses hard structural model-support masks over the measured occupied
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
fixed-frequency capture. The current canonical corpus performs frequency
conditioning, and retagging a scenario-center envelope to a detector peak is
forbidden. However, the failed-v18 audit showed that a valid conditioned
Classic capture still contains an unresolved return/no-return latent process.
Version 19 therefore censors every frequency-agile fixed-tune envelope after
validating the capture and receipt. Bluetooth-like decisions use only the exact
regional spectrum/history population; channel-conditioned cadence remains
display and acquisition-audit evidence and cannot create or imply a
Bluetooth-like, Classic-like, or LE-like decision. A future envelope model
requires independently disclosed event lineage and a validated latent-mixture
contract.

Trainer, tail-calibration, and held-out-validation standard acquisitions offer
32 sequential 50 ms sweeps. Full-band 2.4 GHz acquisitions offer 96, equal to
the agile model's maximum opportunity window, and
still require exactly eight admitted association looks for feature extraction.
The pinned BLE scenario explicitly versions its 20 ms advertising
interval, `packetStartSpacingSeconds=0.0015`, 376 microsecond packet duration,
fixed primary-center order, and seeded per-event `advDelay` in `[0,10 ms)`; the
acquisition check evaluates that engineering schedule rather than inventing
unversioned or universal BLE cadence.
The superseded pre-v19 development regression used eight held-out event-phase
seeds and three interstitial RBWs. In that prior run, BLE acquired at one or more
RBWs for 5/8 seeds at 24 dB and 8/8 at 32 dB. All 32 admitted BLE first-ready
representatives returned Bluetooth-like band activity. Those figures are
historical development evidence, not current release evidence; a fresh v19
report must replace them. Non-admission is still reported as an acquisition
outcome, not negative evidence about BLE in general or a physical device.

The current UI requests a provisional 450 points over 50 ms. This request does
not prove a 9 ksample/s physical sampling rate: actual sample timing, analog
bandwidth, detector response, aliasing, and jitter have not been characterized.
A missing capture, tuning mismatch, partial-span boundary, sweep
time/frequency skew, aliased rate, or short window is retained as a limitation.

## Open-set and fail-loud behavior

This is an engineering reject/open-set policy, not an open-set theorem. Chow's
loss-based reject option does not by itself establish unknown-class validity;
the research basis separately cites the conformal and open-set literature and
states which guarantees are absent.

The primary result is `unknown` when evidence is insufficient, the detection
touches the acquisition boundary, unknown posterior mass is too high, known
posterior mass is too low, no defensible leaf or aggregate clears the decision
rules, the model is unavailable, or inference fails. Frequency is soft context,
inside an eligible structural support domain, while wireless classes also enforce the hard
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
fixed-component radial-tail score to a synthetic support rank. Calibration v19
treats each independent branch acquisition attempt—not correlated fragments
from that attempt—as the reference unit. The consecutive-spectrum score is the
minimum known-class support across all fit-eligible runtime representatives in
the complete 32- or 96-look horizon; each qualified-envelope view uses the
support of its sole fit-eligible rank-0-integrated-excess capture. Exact per-scenario and
per-view score counts are published by the generated training matrix and
independently reconciled validation report. Ties count toward support.

An association retained only by tracker hysteresis is still operator-visible,
but it is not an online-ready classifier window unless its current provenance
independently satisfies the full association promotion gate. Below that gate
feature extraction returns insufficient evidence and the window is excluded
before observation-domain eligibility, not converted into a calibration score.

Tracker readiness alone is not classifier admission. A first-ready
representative is the earliest online-ready opportunity whose complete cited
provenance replays as one coherent scalar window under the frozen-origin and
later-look uniqueness rules. `ObservableEvidenceUnavailableError` makes a
runtime-unavailable window primary `unknown` with `insufficient-evidence`.
Trainer/validator accounting may record and continue past only the declared
retryable non-unique-history or insufficient-ROI-bin reasons. Missing required
coherent provenance, duplicate IDs, contradictions, and other malformed
evidence remain hard failures.

A spectrum member representative's score is no smaller than its spectrum-branch
attempt minimum, so its rank against attempt minima cannot be smaller than the
corresponding attempt-minimum rank. Each envelope view instead uses its
independent branch's sole qualified physical capture. Metadata records that
relationship as
`spectrum-member-dominates-independent-branch-attempt-min-envelope-is-independent-sole-capture-v3`. The fixed,
stratified nuisance grids and pooled scenario templates are not exchangeable
operational samples. Metadata therefore also records
`empirical-synthetic-reference-only-no-exchangeability-or-coverage-guarantee-v1`.
The value is not a conformal p-value and has no finite-sample coverage claim.

Inference selects the matching view, takes the maximum class-conditional
support rank across eligible known classes, and rejects below the engineering
cutoff 0.025. A support rejection must report primary label `unknown`,
confidence zero, and explicit `synthetic-support-rank` value and threshold.
Ranked candidate model posteriors remain available as diagnostic alternatives
but are not the primary confidence or an accepted identity. The rank is not
posterior-predictive parameter integration, physical receiver calibration, or
a guarantee for ambient RF.

Training and regression validation use the production
`bayesian-exponential-multiscale-cfar-v3` detector and two-state tracker, not a
known-presence or max-hold extractor. Trainer fitting, tail calibration, and
held-out validation use 32 sequential opportunities for standard geometry;
full-band 2.4 GHz association scenarios use 96. Fitting,
calibration, and classification consume exactly the latest eight
admitted local or association sweeps. Admission misses
are reported separately from classification conditional on admission. The
tracker's `frequency-agile-2g4-activity-v3`, its
`bayesian-frequency-agile-transition-v3` dynamics evidence, and
`regular-spectral-component-lineage-v2` and `multicomponent-swept-region-v2`
associations participate with their actual runtime provenance and expiry
behavior. This is end-to-end synthetic
detector/tracker/classifier regression, but it remains shared-generator
development evidence rather than physical validation.

## Validation statement for the independently regenerated v19 report

The held-out nuisance-shift validator uses unseen seeds `13001`, `13019`, `13037`, `13063`, `13081`, `13099`, `13127`, and `13151`; SNR values 6/10/16/24/32 dB; interstitial RBW divisors 15.5/44/98; standard 32- and full-band 2.4 GHz 96-opportunity horizons; and an exact eight-admission classification window.
It independently pins and audits the fitted, strict
holdout, ambiguity-only, exact-equivalence, and known-acquisition-only
partitions so regenerated metadata cannot silently move a case. It reports
admission separately from conditional classification and computes proper
scores only on singleton-truth, observation-domain-eligible examples.

The following figures are retained from the superseded pre-v19 development
report only. The report file is currently unavailable, so they are not current
release evidence; a fresh fit, independent regeneration, v19 report, and
publication check must replace them. That development regression ran 4,200 acquisition attempts. It admitted 2,145
attempts (0.510714) and produced 9,944 unique first-ready representatives.
Conditional hierarchical accuracy was 0.985318, known coverage 0.993796,
covered-known hierarchical accuracy 1.0, known top-leaf accuracy 0.993996,
and the minimum high-SNR known-class hierarchical accuracy was 0.9875. On
5,525 singleton-truth proper-score samples, fitted-template log loss was
0.0142141, multiclass Brier score 0.00825527, and ECE 0.00192378. Fitted-unknown
AUROC and rejection were both 1.0; scenario-excluded strict-typicality AUROC
was 0.997999 and admitted strict-holdout rejection was 1.0.

All 840 exact-equivalence nuisance cells yielded 2,278 matched representative
pairs and 4,556 matched evidence-view pairs with zero discrepancies at
`1e-11` tolerance. Exact-equivalence compatibility was 1.0, and both the
unknown false-accept count and disallowed false-accept attempt count were zero.
The replacement `.artifacts/classifier-validation/report.json` must bind its
fields for local integrity with unkeyed `validationAcceptance.evidenceSha256`;
that digest is not provenance authentication. Release evidence requires a fresh
pinned clean-tree rebuild and validator run before publication verification.

Acceptance requires the admitted strict holdout to return `unknown`, every
ambiguity or exact-equivalence case to remain inside its declared compatible
class set, and zero disallowed false acceptances. The one-timeslot GSM case is
the only pinned expected classification non-admission; this exception list
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
- **EMSO-CLS-002:** corpus, model asset, preprocessing, prior, calibration,
  exact training runtime identity, and exact bundled attempt-sampling worker
  SHA-256 identifiers are immutable result provenance.
- **EMSO-CLS-003:** fewer than eight coherent sweeps returns
  `insufficient-evidence`.
- **EMSO-CLS-004:** a boundary-censored event returns `out-of-domain`.
- **EMSO-CLS-005:** unavailable envelope evidence selects `spectrum-only`, and
  qualified envelope evidence without qualified cadence selects
  `envelope-untimed`; every selected view supplies its exact complete feature
  set, and unavailable timing is never converted into negative class evidence.
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
- **EMSO-CLS-016:** fitted unknowns, the strict holdout, ambiguity-only cases,
  exact-equivalence nulls, and known acquisition-only scenarios remain separate
  immutable partitions in model provenance and validation reports.
- **EMSO-CLS-017:** exact-equivalence and ambiguity cases may resolve only to a
  declared compatible evidence class or `unknown`; no UI or metric invents a
  uniquely identifiable source story.
- **EMSO-CLS-018:** HR-DSSS-like and OFDM-like Wi-Fi leaf posteriors are
  diagnostic only. The primary result is `802.11-compatible channel morphology
  · PHY unresolved` or `unknown`, never a protocol or PHY identity.
- **EMSO-CLS-019:** A multicomponent swept-region association begins with at
  least four independently Bayesian-admitted local members, records its
  anchor-containment or resolved-raster qualification, exposes only the latest
  hull/membership, and retains only its latest eight compatible same-geometry
  looks with padded IoU at least 0.75 and a shared component center. It may
  reconnect only inside release hysteresis; missed evidence is unqualified,
  incompatible history is pruned, and an expired lineage is never revived.
  Its zero-span evidence remains local, and neither association nor UI claims
  simultaneity, a common process, or emitter identity.
