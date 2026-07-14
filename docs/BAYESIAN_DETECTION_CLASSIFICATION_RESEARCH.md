# Bayesian detection and waveform classification research basis

Status: implementation design and validation contract  
Updated: 2026-07-14

## Executive conclusion

Atomizer can implement real Bayesian inference over the observations returned by
tinySA. It cannot make every requested waveform identity uniquely observable.
A swept trace is a time-ordered series of scalar powers measured through the
resolution-bandwidth filter; zero span is detected power versus time. Neither
view contains RF phase or complex I/Q samples. Consequently, the scientifically
valid product is:

1. a measurement-conditioned posterior that an emission is present;
2. a posterior over the finest *evidence-equivalence class* supported by the
   acquisition; and
3. an explicit unknown/confuser hypothesis and abstention decision.

The supported observable classes are CW-like, DSB full-carrier AM-like,
FM/angle-modulated-like, GSM-like, LTE-FDD-like, LTE-TDD-like, NR-FDD-like,
NR-TDD-like, cellular-OFDM-ambiguous, Wi-Fi DSSS-like, Wi-Fi OFDM-like,
Bluetooth-like band activity with Classic/LE mode unresolved, and unknown. A
more specific leaf is permitted only when a documented feature actually
distinguishes it. In the implemented decision policy the two Wi-Fi leaves are
diagnostic templates only; the primary result stops at 802.11-compatible
channel morphology with the PHY unresolved.

This is not weaker engineering. It prevents a closed softmax from assigning
high confidence to an identity that the instrument did not observe.

## 1. Measurement model and identifiability

A useful abstraction for sweep bin \(k\) is

\[
y_k = Q_c\!\left(g_c\!\left[\int |X(f,t_k)|^2
|H_{B,c}(f-f_k)|^2\,df+n_k\right]\right)+a_k .
\]

For zero-span sample \(j\),

\[
z_j = Q_c\!\left(g_c\!\left[\int |X(f,t_j)|^2
|H_{B,c}(f-f_0)|^2\,df+n_j\right]\right)+a_j .
\]

The acquisition condition \(c\) includes RBW, detector, attenuation, LNA/gain,
sweep time, firmware, and device. \(Q_c\), \(g_c\), and \(a_k\) include
quantization, log/detector response, AGC, leakage, and settling artifacts.

This model has unavoidable consequences:

- sweep frequency and observation time are entangled;
- phase-only transformations can leave the measured spectrum unchanged;
- a short burst can appear as a partial channel because different bins were
  visited at different times;
- CW is the zero-modulation limit of AM and FM;
- narrow FM can fall within one RBW and look CW-like;
- an off-center or narrow RBW can convert FM into apparent AM;
- fading multiplies received power and can imitate amplitude modulation; and
- integrated power cannot recover QAM order, coding, EVM, cell ID, packet
  contents, or most PHY-generation distinctions.

Tektronix describes the swept analyzer as measuring one RBW-filtered amplitude
point at a time and distinguishes that from vector modulation analysis, which
requires magnitude and phase [1]. tinySA documents approximately 0.5 dB display
resolution, level-accuracy limits, a zero-span center artifact, AGC distortion
of fast AM, and DSP leakage/settling [2-5]. These effects belong in the
likelihood or in an explicit unsupported-acquisition result; they must not be
silently treated as independent Gaussian samples.

## 2. Bayesian presence detection

### 2.1 Decision structure

For hypotheses \(H_0\) (local background) and \(H_1\) (emission contributes
power), with acquisition \(c\),

\[
m_h(D\mid c)=\int p(D\mid\theta_h,H_h,c)
p(\theta_h\mid H_h,c)d\theta_h,
\]

\[
P(H_h\mid D,c)\propto \pi_h(c)m_h(D\mid c).
\]

The posterior does not define the operating decision by itself. With decision
costs \(C_{a,h}\), a detection occurs when the posterior odds, equivalently the
Bayes factor and prior odds, cross the cost-derived threshold. This preserves
the Neyman-Pearson distinction between evidence, prevalence, false alarm, and
miss costs [6].

### 2.2 Posterior-predictive local-noise baseline

For unaveraged linear-power reference cells,

\[
x_i\mid\lambda,H_0\sim\operatorname{Exponential}(\lambda),\qquad
\lambda\sim\operatorname{Gamma}(a,b)
\]

using a rate parameterization. With \(N\) reference cells and
\(S=\sum_i x_i\),

\[
\lambda\mid R\sim\operatorname{Gamma}(a+N,b+S)
\]

and the posterior-predictive null tail is

\[
P(X>x\mid R,H_0)=\left(\frac{b+S}{b+S+x}\right)^{a+N}.
\]

For a requested per-cell tail probability \(q\),

\[
T=(b+S)\left(q^{-1/(a+N)}-1\right).
\]

As \(a,b\rightarrow0\), this becomes the familiar CA-CFAR multiplier
\(N(P_{FA}^{-1/N}-1)\). Finn and Johnson established the adaptive radar
threshold lineage, Rohling developed ordered-statistic CFAR for contaminated
references, and Weinberg gives a Bayesian predictive formulation [7-9].

The exponential law is not assumed for every tinySA mode. Energy detection
under averaging is Gamma/chi-square in the ideal model [10]. tinySA detector,
averaging, log conversion, AGC, quantization, and correlated RBW bins require a
configuration-specific effective shape or an empirical posterior-predictive
null. The detector must retain:

- the null-model/version and acquisition configuration;
- reference and guard-cell counts;
- target and observed posterior-predictive tail probability;
- Bayes factor, prior, and posterior;
- an assumed or calibrated noise shape and effective independent-cell count; and
- the distinction among false alarms per cell, sweep, event, and hour.

The implemented `bayesian-exponential-multiscale-cfar-v3` evaluates a
predeclared family of narrow through wide regions in linear power. The global
threshold only selects which members need evaluation; every possible raw-bin
center and every acquisition-derived scale is included in the multiplicity
count. Each test integrates the unknown local-noise rate using untrimmed outside
references, RBW-limited effective target/reference counts, and a conservative
single-look exponential shape until receiver/configuration-specific calibration
exists. A positive-power-gain mixture supplies the alternative likelihood.
Admission requires posterior signal probability at least 0.99 under a declared
0.01 region prior and a predictive null tail no larger than

\[
0.001/(N_{raw\ points}N_{tested\ scales}).
\]

The union bound therefore limits the ideal-model multiscale family to 0.001 per
sweep without assuming independence among tests. It is not a measured tinySA
false-alarm rate: exponential marginals, effective RBW cell counts, outside
references, detector response, and hardware stationarity remain uncalibrated.
The preceding candidate-local Gamma-shape formulation failed its own
ideal-Gamma Monte Carlo because selection-biased shoulder variance drove the
shape as high as 50 and produced excessive null detections. That hypothesis was
rejected rather than tuned around; v3 fixes the shape at the heavier-tailed
exponential baseline and removes trimmed references.

### 2.3 Temporal inference

Repeated sweeps are correlated. Blindly multiplying their Bayes factors makes
the posterior overconfident. The implemented track state uses a two-state
Bayesian filter:

\[
q^-_t=p_{11}q_{t-1}+p_{01}(1-q_{t-1}),
\]

\[
q_t=\frac{L_1(D_t)q^-_t}
{L_1(D_t)q^-_t+L_0(D_t)(1-q^-_t)}.
\]

The current `bayesian-two-state-track-filter-v1` uses declared persistence 0.92
and appearance 0.01, then updates with only the current candidate Bayes factor.
On a missed sweep it applies the transition prediction only and marks the
result `track-predictive-state`; it does not pretend that absence of a selected
candidate supplied a calibrated miss likelihood or a measurement-conditioned
posterior. Until those transitions and the measurement model are fitted from
sessions, accumulated looks remain engineering evidence, not a calibrated
track probability.

## 3. Observable waveform hypotheses

### 3.1 Analog and CW

| Requested identity | Positive evidence available to tinySA | Confusers and required abstention |
|---|---|---|
| CW | RBW-shaped narrow line; stable integrated detected power across qualified looks | Unmodulated interval of AM/FM, narrow FSK/FM, local spur, drifting source |
| DSB full-carrier AM | Carrier plus mirrored sidebands; consistent sideband spacing; envelope variation | Fading CW, OOK/ASK, DSB-SC, SSB, power control |
| FM | Symmetric broadening or resolved FM sidebands; near-constant total power with sufficiently wide RBW; repeated centroid motion | PM, FSK/GMSK, narrow FM, RBW discriminator artifact |

For sinusoidal DSB full-carrier AM, each sideband-to-carrier power ratio is
\(\mu^2/4\). For sinusoidal FM,

\[
s(t)=A\sum_n J_n(\beta)
\cos(2\pi(f_c+n f_m)t),\qquad \beta=\Delta f/f_m,
\]

and Carson's approximate occupied bandwidth is
\(2(\Delta f+f_{m,\max})\) [11,12]. These formulae define simulators and
nuisance priors; a hand-drawn bell is not a physical validation asset.

Traditional automatic-modulation recognition often uses instantaneous
amplitude, phase, and frequency [13]. Only the first is partially available
through detected-power zero span, so exact AMR labels cannot be transplanted.

### 3.2 GSM/GERAN

GSM has 200 kHz channel spacing and paired FDD operation. A time slot is
approximately 576.923 microseconds and a TDMA frame 4.61538 milliseconds, with
26-, 51-, and 52-frame multiframes [14,15]. A qualified detected-power history
can therefore carry slot/frame periodic envelope energy; the approximately
1.733 kHz slot cadence is useful when sample timing and analog bandwidth support
it. Atomizer's implemented feature is Fourier energy in a detected-power
envelope, not a spectral-correlation or cyclostationarity estimator. BCCH/dummy
bursts can make a carrier appear continuously occupied, so the absence of gaps
is not negative GSM evidence [16].

Scalar power cannot recover GMSK versus EDGE modulation order reliably. The
accepted label is therefore GSM/GERAN-like unless a separately validated
measurement distinguishes more.

### 3.3 LTE FDD and TDD

LTE nominal channel bandwidths are 1.4, 3, 5, 10, 15, and 20 MHz; occupied
resource grids are approximately 1.08, 2.7, 4.5, 9, 13.5, and 18 MHz. The radio
frame is 10 ms, a subframe 1 ms, and a slot 0.5 ms [17,18].

Evidence blocks are:

- occupied-width compatibility, with RBW/sweep censoring;
- a 100 kHz EARFCN raster prior;
- paired-band context for FDD versus an unpaired-band prior for TDD;
- qualified zero-span frame/subframe energy periodicity; and
- cross-channel paired activity as supporting, never mandatory, FDD evidence.

Frequency tables must come from a versioned complete standards table rather
than an abbreviated hand list. TDD/FDD is a contextual posterior, not a hard
frequency rule, because private, translated, test, or mixed signals exist.

### 3.4 5G NR FDD and TDD

NR FR1 spans 410 to 7125 MHz in the cited release. Subcarrier spacing follows
\(15\cdot2^\mu\) kHz. Frames remain 10 ms with 1 ms subframes; normal-CP slots
contain 14 OFDM symbols [19,20]. NR uses NR-ARFCN and a distinct synchronization
raster/GSCN. An SSB occupies 240 subcarriers over four symbols and may recur at
5 through 160 ms depending on configuration [21-23].

Useful evidence is width, supported FR1 band/raster context, possible SSB burst
periodicity, and TDD duty/transition structure. More than 20 MHz of contiguous
cellular-like occupancy favors NR, but adjacent or aggregated LTE is an
explicit confuser. LTE and NR at 20 MHz or below, especially with dynamic
spectrum sharing, must be allowed to return `cellular-OFDM-ambiguous`.

FR2 and bandwidths outside the device's measured support are out of domain, not
negative evidence.

### 3.5 Wi-Fi 802.11

The literature motivates the following *candidate evidence hierarchy* when the
necessary observables are actually resolved [24-29]:

| Observation | Finest defensible result |
|---|---|
| 2.4 GHz DSSS/CCK-like burst | Wi-Fi HR-DSSS-like |
| Fixed 20 MHz OFDM burst | Wi-Fi OFDM 20 MHz; generation ambiguous |
| 40 MHz OFDM | HT-or-later Wi-Fi-like |
| 80/160 MHz OFDM | VHT-or-later Wi-Fi-like |
| 320 MHz Wi-Fi-like OFDM | strong EHT-like evidence if hardware supports the span |
| resolved stable RU/puncture structure | HE/EHT OFDMA-like evidence |

20 MHz legacy, HT, VHT, HE, and EHT emissions are not uniquely distinguishable
from integrated spectrum shape alone. HE/EHT subcarrier or resource-unit
evidence is valid only if the actual RBW and sweep timing resolve it. Packet
duration and gaps depend heavily on rate, aggregation, contention, retries, and
load, so they are better family evidence than generation evidence.

The implemented scalar classifier is deliberately stricter than the candidate
table. Swept integrated power plus a fixed-tune detected-power envelope contains
no decoded preamble, DSSS/CCK correlation, cyclic-prefix measurement, or
qualified cyclostationarity. Its HR-DSSS-like and OFDM-like leaf posteriors are
diagnostic only; the primary result is at most `802.11-compatible channel
morphology · PHY unresolved` (or `unknown`). Exact proprietary DSSS and OFDM
nulls demonstrate why even that result is an evidence-equivalence statement,
not 802.11 protocol or PHY identity.

### 3.6 Bluetooth

Bluetooth Classic uses 79 centers on a 1 MHz raster in 2.4 GHz, 625 microsecond
slots, 1/3/5-slot packets, and connection hopping up to 1600 hops/s; inquiry and
page procedures can reach 3200 hops/s [30-32]. Bluetooth LE uses 40 centers on a
2 MHz raster. Primary advertising channels are 2402, 2426, and 2480 MHz [33,34].

With a receiver or event tracker that actually preserves cross-channel
provenance, power-only results can include:

- repeated 1 MHz-raster hopping: a Classic-compatible contribution to
  Bluetooth-like band-activity evidence, with proprietary FHSS as an explicit
  confuser;
- time-associated activity on configured primary advertising centers with
  event timing/jitter: supporting Bluetooth-LE-advertising-like evidence, not
  protocol identity; absence from one primary channel is not negative evidence;
- time-associated activity compatible with an LE 2 MHz channel-center lattice:
  an LE-compatible contribution to Bluetooth-like band-activity evidence, with
  proprietary FHSS as an explicit confuser; and
- measured bandwidth compatible with LE 2M: non-identifying against BR/EDR and
  proprietary confusers.

None of these observations uniquely identifies Bluetooth. They become useful
only as a coherent, time-qualified multichannel pattern evaluated against
proprietary FHSS and other 2.4 GHz confusers.

LE 1M and LE Coded are generally power-equivalent; unknown payload length makes
a single packet duration non-identifying. BR/EDR modulation order is likewise
unsupported without richer evidence.

A fixed-frequency tinySA zero-span capture cannot observe a link-wide Classic
slot schedule or an LE advertising event across all three primary channels. It
sees only visits to the tuned Classic channel or the packet sent on one tuned LE
advertising channel. SignalLab must therefore synthesize `classic-slots` and
`ble-advertising-events` power conditional on the recorded tuned frequency. The
resulting envelopes describe channel-local visits or packets, not link-wide
activity, and are not a defensible Classic/LE discriminator by themselves. An
unconditioned envelope or one merely retagged to a detector peak is invalid.

The production tracker is frequency-local by default and also has a disclosed
`frequency-agile-2g4-activity` association with provenance
`frequency-agile-2g4-activity-v3` and conditional dynamics model
`bayesian-frequency-agile-transition-v2`. Across a strictly ordered full-band
2.4 GHz sweep sequence, it records none, exactly-one eligible narrow candidate,
or ambiguous activity for every opportunity. Only positive unambiguous looks
enter the agile-versus-stationary transition marginal; none and ambiguous looks
remain explicit provenance rather than invented negative evidence. This
accumulates broad band-activity evidence only. It does not establish transmitter
or link identity, recover a hop clock or sequence, or prove an LE advertising
triplet; unrelated emitters can be merged and real activity can remain
fragmented. Classic/LE separation is not modeled. Without independently
observed distinguishing evidence the primary decision remains Bluetooth-like
band activity or `unknown`, never a timing-promoted mode.

Transition model v2 uses an equal mixture of Classic `Beta(78,1)` and LE
`Beta(2,1)` change-rate marginals against a predeclared *fixed* stationary
Bernoulli likelihood `p_change=0.05`. It does not integrate the stationary
likelihood over the formerly used Beta prior. Exact dynamic programming over
transition counts gives a sequential false-promotion probability of
`1.3657385209e-5` through 96 positive looks under that independent fixed-5%
null. The computation omits the separate minimum-three-resolution-cell guard,
so it is a conservative upper bound inside the declared transition model. It is
not a physical false-association guarantee and does not cover correlated
receiver artifacts, nonstationary traffic, or unrelated emitters merged by the
provisional association.

Standard scenarios offer 24 sequential 50 ms opportunities. Full-band 2.4 GHz
scenarios offer 96, matching the association model's bounded opportunity
window, so sparse activity is evaluated over a declared finite horizon rather
than a previously aliased 24-look slice. The pinned BLE scenario versions its
20 ms advertising interval and 1.5 ms within-event packet spacing. Across the
final eight held-out event-phase seeds and three interstitial RBWs, at least one
RBW acquired BLE in 5/8 seeds at 24 dB and 8/8 at 32 dB; all 32 admitted BLE
first-ready representatives returned only Bluetooth-like band activity. A
failure to admit remains an acquisition limitation, not negative evidence
about an observed device.

## 4. Hierarchical open-set classifier

The classifier models family blocks instead of multiplying correlated feature
Gaussians. For class \(c\), nuisance state \(\theta\), and acquisition \(m\),

\[
p(c\mid x,m)\propto p(c\mid \text{band})
\int p(x\mid c,\theta,m)p(\theta\mid c)d\theta.
\]

Recommended blocks are:

- spectral extent/shape: occupied widths, edge symmetry, carrier fraction,
  sideband mirror evidence, flatness, raster correlation, fragmentation;
- temporal envelope: active-state posterior, censored bursts/gaps, cadence,
  jitter, duty and transition structure;
- history: fixed-channel persistence and disclosed broad frequency-agile band
  activity; hop transitions, paired-channel, or advertising-triplet evidence
  only when a future validated linker preserves the necessary provenance; and
- context/acquisition: band/raster priors, RBW, sweep skew, detector, noise
  uncertainty, device and observation duration.

Within-block features may use a multivariate Student-t likelihood or an
empirical density. Blocks may be combined only when conditional-independence
tests or a hierarchical model justify it. Family priors are independent of the
number of catalog profiles, so adding 40 NR fixtures cannot inflate the NR
posterior.

The implemented `bayesian-observable-equivalence-v5` model extracts 28 scalar
features from repeated sweeps and optional qualified detected-power zero span.
Its 12-leaf denominator contains 11 known leaves and `unknown-signal`.
Regularized empirical multivariate Student-t likelihood components are fitted
only from examples admitted by the production Bayesian detector and two-state
tracker. The final generated asset contains 18 components fitted from 8,140
detector-conditioned, fit-eligible first-ready production representatives. Component
locations and covariance structure are plug-in estimates, degrees of freedom
are fixed at 7, and the regularization is prescribed by the trainer. This is not
a Bayesian posterior-predictive distribution over uncertain fitted parameters.

Likelihoods use the exact marginal of each fixed Student-t component on only
the observed dimensions, so missing or unsupported cadence features are not
imputed. The normalized outputs are model posteriors conditional on the fixed
empirical likelihoods, `engineering-design-class-weights-v1` priors,
hand-coded band context, and the observed features. They are not physically
calibrated probabilities. The final model-asset SHA-256 is
`bb4393e1e0e0e86977def9238a4e1e3dc03511f06b421384ff41316e37e96c9d`.
Preprocessing is `scalar-observable-features-v5`, representative eligibility is
`runtime-domain-qualified-known-representatives-v3`,
calibration is
`synthetic-view-matched-conformal-independent-attempt-min-support-detector-conditioned-physical-uncalibrated-v6`,
and decision policy is `observable-open-set-decision-v9`.

Known wireless hypotheses also have hard fitted-domain eligibility masks. They
test the measured occupied interval—center plus bandwidth with a bounded RBW
edge allowance—against the supported model bands and widths. A center that lies
inside a band cannot rescue an interval extending outside it. These are model
support boundaries, not statements that the standards forbid other allocations;
unsupported standards-compliant observations remain `unknown`.

The fitted `unknown-signal` likelihood contains only `unknown-narrow-fsk` and
`unknown-802154`. The remaining corpus scenarios are partitioned before
fitting so that unlike scientific questions are not collapsed into one
"unknown accuracy" number:

- strict unknown holdouts: `unknown-chirp` and `unknown-impulsive`;
- ambiguity-only stress: regular four-/five-line combs, the irregular
  three-line multitone, stationary intermittent 2.4 GHz activity, the
  simultaneous 1 MHz raster, four interleaved channels, and proprietary
  off-raster FHSS;
- exact observable-equivalence nulls: an instrument spur, independent AM- and
  FM-equivalent line models, generic OFDM matching LTE FDD, LTE TDD, and Wi-Fi
  80 MHz projections, and proprietary DSSS matching the Wi-Fi HR-DSSS
  projection; and
- known acquisition validation only: one-timeslot `gsm-900-tdma`.

Strict holdouts must be rejected. Ambiguity and exact-equivalence cases must
produce only a declared compatible class or `unknown`; forcing all of them to
`unknown` would claim information the scalar measurement does not contain. The
one-timeslot GSM scenario may fail the finite swept-acquisition admission gate;
the separately pinned loaded BCCH/dummy-burst scenario supplies the fitted GSM
morphology. Collisions, overload, ambient emissions, and other unmodeled
confusers remain intended open-set scope without a current physical guarantee.

For each known class, generator-separated calibration converts the maximum
fixed-component radial-tail score into an inductive rank support p-value,
\((r+1)/(n+1)\). Calibration v6 uses an acquisition attempt as the exchangeable
unit, rather than flattening correlated fragments. For every fit-eligible
attempt, class, and evidence view it records the minimum known-class support
among that attempt's first-ready eligible representatives. The asset contains
1,990 independent attempt-level scores per evidence view, distributed over the
known classes, for `spectrum-only`, `envelope-untimed`, and `envelope-timed`.
Inference selects the matching view, takes the maximum class-conditional
support p-value across eligible known classes, and rejects below 0.025. On that
support rejection the primary result is
`unknown` with confidence zero and explicit `synthetic-support-p-value` value
and cutoff; ranked candidate model posteriors are retained only as diagnostics.
Its nominal 2.5% support coverage has meaning only when the new observation is
exchangeable with the pinned SignalLab synthetic calibration generator under
the same evidence view. It is not a posterior-predictive p-value, physical
receiver calibration, or a guarantee for ambient RF. Chow's reject rule maps
an abstention cost to an acceptance threshold [35].

Any fitted temperature or probability calibration is learned on untouched,
session-grouped validation data. Temperature scaling can calibrate scores; it
does not transform an arbitrary score into a likelihood [36].

## 5. Acquisition qualification

Features are `available`, `censored`, or `unsupported`; missing evidence is
never silently scored as evidence against a class.

When a runtime event is first admitted, the detector freezes its accepted
frequency region and records the originating sweep ID. Track updates preserve
that first-admission region and origin record rather than recentering it, while
appending only independently re-detected sweep IDs to the event evidence.

The provisional `frequency-agile-2g4-activity` path never widens or replaces
this emission region. Association model `frequency-agile-2g4-activity-v3`
records a strictly ordered opportunity stream over the full 2402--2480 MHz
geometry: no candidate, exactly one eligible independently CFAR-admitted narrow
candidate, or an ambiguous look. Its separately versioned
`bayesian-frequency-agile-transition-v2` dynamics model integrates
an equal Classic/LE Beta-Binomial marginal against the fixed stationary
`p_change=0.05` Bernoulli likelihood, conditional on positive, unambiguous
observations. It requires at least eight positives across at least three
resolution cells and uses a maximum 96-opportunity window with explicit 0.99
promotion and 0.90 retention probabilities. Occurrence and duty probability
deliberately cancel between its agile and stationary hypotheses; it does not
invent an SNR model. The association carries a separate bounded region, source sweeps, local
detector evidence, and both model IDs. Feature extraction may use it only as
broad band-activity evidence, never as an emitter, link, hop sequence, or
advertising-triplet identity.

The separate `regular-spectral-component-activity` association is likewise
classification provenance, not a merged detection. It starts only from at
least three independently admitted, simultaneous narrow local tracks; retains the exact
member-track IDs, bounded group region, source sweeps, association ID, and
`simultaneous-regular-components-v1` model ID; and abstains when an irregular
interior component or overlapping regular hypotheses make membership ambiguous.
Its miss counter and expiry are independent of local track persistence, so
expiry removes only the group evidence. Feature extraction requires exactly the
latest eight admitted association looks. The UI computes one classification per
association and maps it back to all member rows while continuing to display each
member as a local detection. Neither the association nor its result establishes
that the lines share an emitter.

Feature extraction accepts only provenance-bound coherent sweeps with
matching frequency grid, RBW, attenuation, detector, gain state, device, and
firmware/execution identity; zero-span evidence is also bound to the target
detection and device identity. The extractor uses every admitted source sweep
inside the applicable provenance region for a fixed most-recent eight-admission
window. A standard sampling attempt offers 24 sequential opportunities; a
full-band 2.4 GHz attempt offers 96 so sparse frequency-agile activity has a
declared finite horizon. Longer track history is not pooled into look-count-
dependent maxima or variances. The extractor does not apply a second 3 dB
active-bin admission gate;
feature-local peak/cluster thresholds describe shape but do not decide whether
the event enters classification.

At minimum, every classification stores:

- actual start/stop/RBW, nominal bin width, detector, attenuation and gain;
- sweep duration and, when available, per-bin timing;
- zero-span center, RBW, actual sample period, duration and completeness;
- frequency/bandwidth boundary censoring;
- source sweep/capture IDs and device/firmware identity; and
- every feature's qualification reason.

The former 290-point/100 ms default had a nominal 2.9 ksample/s request rate and
could not resolve a 1.733 kHz GSM or 2 kHz LTE energy cadence without aliasing.
The current 450-point/50 ms request has a nominal 9 ksample/s request rate and is
a useful provisional acquisition, but physical captures remain
`wall-clock-derived`. Actual per-sample timing, detector bandwidth, aliasing,
jitter, and the tinySA response are not calibrated. The classifier therefore
excludes every physical cadence-rate feature, including transition rate and
periodic envelope energy, unless timing is explicitly `measured-calibrated`;
`simulation-exact` timing is permitted only for synthetic validation. These
features are Fourier energies in detected-power histories, not
cyclostationarity or spectral-correlation estimates.

Timing qualification does not repair a frequency mismatch. In particular,
link-wide Bluetooth Classic slot activity and aggregate LE advertising-event
timing must be excluded from fixed-frequency zero-span classification even when
their simulator clock is exact. The canonical corpus now synthesizes received
power conditional on the actual tuned channel; that channel-local timing remains
supporting, non-identifying evidence.

Adaptive acquisition should select the next measurement by expected posterior
information gain. Typical follow-ups are narrower RBW for line/sideband shape,
wider RBW for total envelope power, zero span at center and the documented
quarter-RBW offset, and a window long enough to cover repeated candidate
frames/events.

## 6. SignalLab canonical corpus contract

The existing 79 visual profiles remain UI fixtures. They are not the
classifier's physical training truth or posterior taxonomy. SignalLab has the
separate immutable `observable-scalar-corpus-v7`, with 35 canonical scenarios
(17 known and 18 unknown/confuser) at commit
`03197cb5b4a03b85ef5efe6525f4f28ceedcaef3` and source SHA-256
`d813b3268eee7240a86b2de725ec78080dc0f3ce829fe0c493bf582b62f8529e`.
Its component-fit exclusions are the strict holdouts, ambiguity-only cases,
exact-equivalence nulls, and the acquisition-only one-timeslot GSM case listed
in Section 4. Those partitions are immutable model metadata and are audited
against the validator's independent pinned lists. The corpus records:

- stable evidence-class ID and scenario ID;
- formula or standards clause and source URL;
- complete truth parameters, nuisance parameters, and random seed;
- generator/version, sample rate, duration and SHA-256 digest;
- optional I/Q truth used only to produce scalar observations;
- an explicit instrument-response configuration;
- expected scalar sweep/zero-span observations and feature qualifications;
- `physics-derived`, `standards-derived`, or `physical-capture` provenance;
- disclosure that synthetic assets are not conformance waveforms; and
- for captures, generator/device/session/environment/calibration-chain IDs.

Version 7 makes acquisition time part of the scalar observation. GSM TDMA,
LTE/NR TDD, and Wi-Fi CSMA schedules gate each spectrum bin at that bin's
actual visit time, rather than drawing a continuous channel and applying traffic
only to zero span. It separates a one-timeslot GSM acquisition stress case from
a loaded BCCH/dummy-burst carrier suitable for fitting. Its AM and FM zero-span
captures coherently combine the modeled spectral components through the
configured Gaussian RBW filter at the actual tune frequency; off-center or
narrow-RBW captures can therefore become CW-like without fabricating an ideal
baseband envelope. Exact-equivalence scenarios deliberately reproduce the same
admitted scalar observations from a different source story.

The implemented baseline contains at least one synthetic template for every
known leaf, but its synthetic unknown templates are not a sufficient physical
open set. Corpus expansion must still cover broader noise, OOK, DSB-SC, SSB,
PM, swept carriers, microwave interference, overload, adjacent-channel
composites, Wi-Fi/Bluetooth collisions, and physical multi-emitter mixtures.

A future comprehensive synthetic matrix should vary carrier offset,
burst-to-sweep phase, fading, duration, traffic state, channel width, mixtures,
and receiver response. The implemented fitting and regression matrices vary
SNR, seed/look, and RBW divisor around fixed scenario formulas and acquisition
geometry. They do not cover that comprehensive matrix and cannot calibrate
real-world probabilities.

## 7. Validation and acceptance

### 7.1 Detector

The current validator's default nominal-null design exercises 450-point sweeps,
analytic Gamma shapes 1/2/6/12, and independent or three-cell block-correlated
noise. It runs 8,000 null sweeps for each of the eight predeclared
shape/correlation configurations: 64,000 sweeps, 28.8 million nominal cells,
and 19.2 million correlation-adjusted effective cells. Shape 1 is the exact
implemented exponential model; shapes above 1 are conservative averaged-power
variants. A Bonferroni simultaneous-family 95% Wilson interval, not eight
unadjusted pointwise intervals, must place every configuration's sweep false-
alarm upper bound at or below the actual 0.001 ideal-model target. The trial
count is itself an acceptance gate; reducing it cannot silently weaken the
interval.

The final nominal run observed zero detections in all 64,000 null sweeps. The
Bonferroni simultaneous-family 95% upper Wilson bound was 0.000933724 for every
predeclared configuration, below the 0.001 target. These are 28.8 million
nominal cells but only 19.2 million correlation-adjusted effective cells; the
sweep, not a nominal bin, is the false-alarm trial.

The signal matrix uses the exact production detector, one- and eight-RBW-wide
signals, SNR 0/5/10/15/20/25/30 dB, common random numbers for pointwise
monotonicity, and pointwise 95% Wilson lower-bound gates of 0.15/0.60/0.75/0.90
at 15/20/25/30 dB respectively. A separate audit requires detector topology,
predictive tails, and posteriors to be invariant to
a common linear-power gain within numerical tolerance. Sloped backgrounds,
in-span gain discontinuities, declared spurs, impulses, and compound heavy-tail
clutter are reported separately as out-of-model susceptibility; they are never
laundered into the stationary common-scale false-alarm claim. These are
analytic simulations and acceptance requirements, not tinySA receiver
calibration.

The final signal run comprised 56,000 trials. The worst observed pointwise 95%
lower bounds at 15/20/25/30 dB were respectively 0.387301, 0.693591, 0.848580,
and 0.939026, above their 0.15/0.60/0.75/0.90 gates. There were zero paired
monotonicity violations. Two thousand exact-model common-scale comparisons had
zero topology mismatches (maximum posterior difference `2.22e-16`). The
separately reported out-of-model sweep detection rates were 0 for a 6 dB
linear slope, 0.011 for a 6 dB in-span gain step, 0.547 for declared impulses,
and 0.914 for compound heavy-tail texture. Those susceptibility numbers carry
no nominal false-alarm guarantee.

For each supported physical acquisition configuration:

- report posterior-predictive goodness of fit on terminated/shielded input;
- report achieved per-cell and per-sweep false-alarm intervals;
- report false events/tracks per hour;
- report probability of detection versus input SNR and bandwidth;
- test reference contamination, edges, overload, drift, and correlations; and
- publish exact binomial or session-bootstrap confidence intervals.

A roughly 10% relative, 95% estimate of \(P_{FA}=10^{-3}\) needs about
\(4\times10^5\) effectively independent trials; \(10^{-5}\) is on the order of
\(4\times10^7\). Nominal bin count cannot substitute for effective trials.

### 7.2 Classifier

The trainer and classifier regression validator now use the production
`bayesian-exponential-multiscale-cfar-v3` detector and runtime two-state tracker,
including the provenance-bearing frequency-agile and regular-component
classification associations. They do not use a known-presence or max-hold
oracle. Each synthetic example supplies 24 sequential 50 ms observation
opportunities, or 96 for full-band 2.4 GHz association scenarios; fitting,
calibration, and scoring use exactly the latest eight admitted local or
association sweeps. Admission misses and conditional classification results are
reported separately.

The final regression matrix uses held-out nuisance seeds 13001, 13019, 13037,
13063, 13081, 13099, 13127, and 13151; SNR 6/10/16/24/32 dB; and interstitial
RBW divisors 15.5/44/98 rather than a fitted or support-calibration grid point.
It audits the fitted unknowns, two strict unknown holdouts, seven ambiguity-only
cases, seven exact-equivalence pairs,
and the acquisition-only one-timeslot GSM case separately. Strict holdouts must
reject; ambiguity and exact-equivalence decisions must stay within each
scenario's declared compatibility set; and no disallowed false acceptance is
permitted. Proper scores are computed only for identifiable, fit-eligible
examples. Expected acquisition non-admission for the chirp and one-timeslot GSM
is reported rather than converted into a wrong-class event. All nominal LTE/NR
cases at 20 MHz or below must preserve the deliberate cellular-OFDM ambiguity.

The run covered 4,200 acquisition attempts, admitted 2,145 (0.510714), and
produced 9,944 unique first-ready representatives. Conditional hierarchical
accuracy was 0.985318, known coverage 0.993796, covered-known hierarchical
accuracy 1.0, known top-leaf accuracy 0.993996, and minimum high-SNR
known-class hierarchical accuracy 0.9875. On 5,525 singleton-truth,
fit-eligible proper-score samples, fitted-template log loss was 0.0142141,
multiclass Brier score 0.00825527, and expected calibration error 0.00192381.
Fitted-unknown AUROC and rejection were 1.0; scenario-excluded strict-
typicality AUROC was 0.997999 and admitted strict-holdout rejection was 1.0.

The exact-pair audit covered 840 nuisance cells, 2,278 representative pairs,
and 4,556 evidence-view pairs with zero discrepancies at `1e-11` tolerance.
Compatibility was 1.0, with zero unknown false accepts and zero disallowed
false-accept attempts. BLE high-SNR acquisition covered 5/8 independent seeds
at 24 dB and 8/8 at 32 dB at one or more held-out RBWs. These remain
synthetic-domain results from a shared generator/instrument projection, not
physical calibration, untouched validation, protocol identity, or emitter
identification.

Physical validation must report on untouched sessions/devices/environments:

- class and hierarchical confusion matrices;
- log loss and multiclass Brier score;
- classwise reliability and expected calibration error;
- unknown AUROC/AUPR and known/unknown false-accept rates;
- accuracy-versus-coverage and risk-versus-coverage under abstention;
- results by SNR, RBW, sweep duration, device and channel;
- posterior-predictive checks and prior sensitivity; and
- confidence intervals grouped by session, never randomly by adjacent trace.

Simulation-based calibration verifies inference implementation [37]. Proper
scores and reliability assess probabilistic quality [38,39]. Neither proves the
physical likelihood is correct; that requires physical capture validation.

### 7.3 Claim gates

1. Deterministic unit and synthetic tests may claim mathematical and contract
   correctness only.
2. Re-simulations of fitted SignalLab templates may claim nuisance-shift
   synthetic regression behavior only. Templates excluded from component
   fitting may claim limited scenario-excluded behavior, but the current
   feature and decision-threshold design was developed against this matrix, so
   it is not untouched validation.
3. A probability becomes physically calibrated only after frozen,
   configuration-matched, session-grouped physical validation.
4. Exact labels are enabled only after a documented identifiability and
   calibration gate; otherwise Atomizer returns the ancestor/equivalence class
   or `unknown`.
5. No finite test suite proves the classifier is "exactly right." The auditable
   guarantee is that its model, evidence, uncertainty, abstention, limitations,
   and validation domain are exact and reproducible.

## Primary and official sources

1. [Tektronix, What is a spectrum analyzer?](https://www.tek.com/en/documents/primer/what-spectrum-analyzer-and-why-do-you-need-one)
2. [tinySA FAQ](https://tinysa.org/wiki/pmwiki.php?n=Main.FAQ)
3. [tinySA RBW](https://tinysa.org/wiki/pmwiki.php?n=Main.RBW)
4. [tinySA scanning speed](https://tinysa.org/wiki/pmwiki.php?n=Main.SCANNINGSPEED)
5. [tinySA Ultra specification](https://tinysa.org/wiki/pmwiki.php?n=TinySA4.Specification)
6. [Neyman and Pearson, 1933](https://doi.org/10.1098/rsta.1933.0009)
7. [Finn and Johnson, adaptive detection, 1968](https://www.rsp-italy.it/Electronics/Magazines/RCA%20Review/_contents/RCA%20Review%201968-09.pdf)
8. [Rohling, ordered-statistic CFAR, 1983](https://doi.org/10.1109/TAES.1983.309350)
9. [Weinberg, Bayesian predictive CFAR, 2019](https://doi.org/10.1049/iet-rsn.2018.5635)
10. [Urkowitz, energy detection, 1967](https://doi.org/10.1109/PROC.1967.5573)
11. [Carson, frequency modulation bandwidth, 1922](https://doi.org/10.1109/JRPROC.1922.219793)
12. [Armstrong, frequency modulation, 1936](https://doi.org/10.1109/JRPROC.1936.227383)
13. [Azzouz and Nandi, automatic modulation recognition, 1995](https://doi.org/10.1016/0165-1684(95)00083-P)
14. [3GPP TS 45.005](https://www.etsi.org/deliver/etsi_ts/145000_145099/145005/19.00.00_60/ts_145005v190000p.pdf)
15. [3GPP TS 45.002](https://www.etsi.org/deliver/etsi_ts/145000_145099/145002/16.01.00_60/ts_145002v160100p.pdf)
16. [3GPP TS 45.008](https://www.etsi.org/deliver/etsi_ts/145000_145099/145008/14.00.00_60/ts_145008v140000p.pdf)
17. [3GPP TS 36.101](https://www.etsi.org/deliver/etsi_ts/136100_136199/136101/18.05.00_60/ts_136101v180500p.pdf)
18. [3GPP TS 36.211](https://www.etsi.org/deliver/etsi_ts/136200_136299/136211/16.06.00_60/ts_136211v160600p.pdf)
19. [3GPP TS 38.104](https://www.etsi.org/deliver/etsi_ts/138100_138199/138104/18.12.00_60/ts_138104v181200p.pdf)
20. [3GPP TS 38.211](https://www.etsi.org/deliver/etsi_ts/138200_138299/138211/18.07.00_60/ts_138211v180700p.pdf)
21. [3GPP TS 38.331](https://www.etsi.org/deliver/etsi_ts/138300_138399/138331/18.08.00_60/ts_138331v180800p.pdf)
22. [3GPP TS 38.213](https://www.etsi.org/deliver/etsi_ts/138200_138299/138213/18.02.00_60/ts_138213v180200p.pdf)
23. [Gardner, cyclostationarity, 1988](https://doi.org/10.1109/26.3769)
24. [IEEE 802.11-2024](https://standards.ieee.org/ieee/802.11/10548/)
25. [IEEE 802.11ax-2021](https://standards.ieee.org/ieee/802.11ax/7180/)
26. [IEEE 802.11be-2024](https://standards.ieee.org/ieee/802.11be/7516/)
27. [IEEE HE resource-unit discussion](https://www.ieee802.org/11/email/stds-802-11-tgax/msg01279.html)
28. [IEEE EHT spacing discussion](https://www.ieee802.org/11/email/stds-802-11-tgbe/msg02717.html)
29. [IEEE EHT RU/MRU discussion](https://www.ieee802.org/11/email/stds-802-11-tgbe/msg03935.html)
30. [Bluetooth Core Specification 6.3](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Core_v6.3/out/en/index-en.html)
31. [Bluetooth BR/EDR radio physical layer](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Core_v6.3/out/en/br-edr-controller/radio-physical-layer-specification.html)
32. [Bluetooth BR/EDR baseband](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Core_v6.3/out/en/br-edr-controller/baseband-specification.html)
33. [Bluetooth LE radio physical layer](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Core_v6.3/out/en/low-energy-controller/radio-physical-layer-specification.html)
34. [Bluetooth LE link layer](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Core_v6.3/out/en/low-energy-controller/link-layer-specification.html)
35. [Chow, optimum recognition error and reject tradeoff, 1970](https://doi.org/10.1109/TIT.1970.1054406)
36. [Guo et al., calibration of modern neural networks, 2017](https://proceedings.mlr.press/v70/guo17a.html)
37. [Talts et al., simulation-based calibration, 2018](https://arxiv.org/abs/1804.06788)
38. [Gneiting and Raftery, proper scoring rules, 2007](https://doi.org/10.1198/016214506000001437)
39. [Gelman, Meng and Stern, posterior-predictive assessment, 1996](https://www3.stat.sinica.edu.tw/statistica/j6n4/j6n41/j6n41.htm)
