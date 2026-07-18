# Bayesian detection and waveform classification research basis

Status: implementation design and validation contract  
Updated: 2026-07-15

## Executive conclusion

Atomizer can implement Bayes-rule inference over the observations returned by
tinySA. The detector integrates a declared local-noise parameter; the classifier
uses fixed plug-in empirical likelihoods and engineering priors. It cannot make
every requested waveform identity uniquely observable.
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
Bayes factor and prior odds, cross the cost-derived threshold. That is a
Bayes-risk decision rule [40]. Neyman-Pearson testing is an alternative
operating formulation: it fixes a false-alarm constraint and maximizes power,
without prior odds or decision costs [6]. Evidence, prevalence, loss, achieved
false alarms, and misses must therefore be reported separately rather than
attributed to one framework.

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
threshold lineage in their 1968 RCA Review article (pp. 414--464), Rohling
developed ordered-statistic CFAR for contaminated references, and Weinberg gives
a Bayesian predictive formulation [7-9].

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

For sinusoidal DSB full-carrier AM, with modulation index \(\mu\)
(conventionally \(0\leq\mu\leq1\) for a non-overmodulated envelope), each
sideband-to-carrier power ratio is \(\mu^2/4\). For sinusoidal FM,

\[
s(t)=A\sum_n J_n(\beta)
\cos(2\pi(f_c+n f_m)t),\qquad \beta=\Delta f/f_m,
\]

and Carson's rule gives the engineering transmission-bandwidth estimate
\(B_C\approx2(\Delta f+f_{m,\max})\) [11,12]. It is not an exact or regulatory
occupied-bandwidth definition. These formulae define simulators and nuisance
priors; a hand-drawn bell is not a physical validation asset.

SignalLab's `occupiedBandwidthHz` fields therefore describe explicit replay
support projections, not one universal OBW measurement. The CW value of 2 kHz
is a nominal display-support floor for a mathematical line, not analyzer RBW or
source-emission OBW. The AM value of 52 kHz is the 50 kHz outer-sideband spacing
plus that nominal 2 kHz display floor, not measured or regulatory OBW. Actual
rendered line width follows each observation's RBW and may extend beyond those
nominal display-support fields. The FM value of 200 kHz
is Carson's engineering estimate \(2(75\text{ kHz}+25\text{ kHz})\), not exact
containment: the physical Bessel series retains nonzero higher-order energy,
while the deterministic renderer truncates numerically at orders \(n=\pm10\)
and amplitude magnitude \(10^{-5}\).

Traditional automatic-modulation recognition often uses instantaneous
amplitude, phase, and frequency [13]. Likelihood-based classifiers operate on
complex I/Q samples or model-derived statistics under explicit idealized signal
and channel models; other canonical branches use higher-order cumulants or
cyclic statistics [23,43-46]. Raw I/Q is not a universally sufficient reduced
statistic across unmodeled channel and receiver effects. These sources describe
the historical algorithmic lineage, but they do not validate a scalar swept-
power classifier. Only amplitude is partially available through detected-power
zero span, so their exact AMR labels cannot be transplanted.

### 3.2 GSM/GERAN

GSM has 200 kHz channel spacing and paired FDD operation. A TDMA frame contains
eight approximately 576.923 microsecond timeslots and lasts 4.61538
milliseconds, with 26-, 51-, and 52-frame multiframes [14,15]. A fixed timeslot
therefore recurs at approximately 216.667 Hz. The approximately 1.733 kHz rate is
only the aggregate slot-boundary rate, and is useful only when successive slots
or their guard intervals create detected-power transitions that the sample
timing and analog bandwidth resolve. TS 45.008 clause 7.1 requires the BCCH
carrier to transmit continuously on every timeslot and otherwise-unused
timeslots to carry dummy bursts, so a loaded BCCH carrier can suppress useful
envelope contrast [16]. TS 45.002 defines the TDMA timing and dummy-burst
structure [15]; it is not the source of that continuous-transmission
requirement. Neither rate is mandatory GSM evidence.
Atomizer's implemented feature is Fourier energy in a detected-power envelope,
not a spectral-correlation or cyclostationarity estimator.

Scalar power cannot reliably distinguish the GSM GMSK mode from EDGE
modulation modes [53]. The accepted label is therefore GSM/GERAN-like unless a
separately validated measurement distinguishes more. Fitted GSM eligibility uses the complete
observed interval against the FDD rows transcribed from TS 45.005 19.0.0 clause
2 in `standards-operating-band-context-v1`; this is structural support, not an
observation of GERAN protocol or paired-link activity [14].

### 3.3 LTE FDD and TDD

LTE nominal channel bandwidths are 1.4, 3, 5, 10, 15, and 20 MHz; occupied
resource grids are approximately 1.08, 2.7, 4.5, 9, 13.5, and 18 MHz. The radio
frame is 10 ms, a subframe 1 ms, and a slot 0.5 ms [17,18].
SignalLab's 9 and 18 MHz `occupiedBandwidthHz` fields are those nominal
allocated RB-grid spans (respectively (50\times12\times15\) kHz and
(100\times12\times15\) kHz), not nominal channel bandwidth or measured
99%-power or regulatory occupied bandwidth.

The 0.5 ms slot boundary has a 2 kHz reciprocal time scale; it is not a 2 kHz
frequency-domain resource-grid boundary and does not guarantee a 2 kHz
detected-power cadence. Downlink occupancy can remain continuous across it.
Simulator or measured timing evidence must distinguish that time boundary from
the 1 ms subframe, 10 ms frame, and TDD 5/10 ms switching periodicities defined
by the configured frame structure [18].

SignalLab corpus v13 retains a Band 38 TDD scenario narrower than those general
facts. `lte-tdd-config0-ssp7-normal-cp-downlink-v1` is a downlink-only
projection using UL/DL configuration 0
(`DSUUUDSUUU`), normal cyclic prefixes, and special-subframe configuration 7
with `srs-UpPtsAdd` absent (`X=0`). With
\(T_s=1/30{,}720{,}000\) s, each special subframe contains 21,952 \(T_s\)
(714.583333 microseconds) DwPTS, 4,384 \(T_s\) (142.708333 microseconds) guard
period, and 4,384 \(T_s\) (142.708333 microseconds) UpPTS. Only full downlink
subframes and DwPTS are active in this downlink-only projection, giving exact
downlink duty 0.3429166667; GP and UpPTS are inactive. Configuration 7 is a
versioned SignalLab scenario choice, not a consequence of Band 38 or UL/DL
configuration 0 and not a universal LTE-TDD deployment default [49].

Candidate evidence blocks motivated by the standards are:

- occupied-width compatibility, with RBW/sweep censoring;
- EARFCN-raster compatibility when the measurement resolves it;
- paired/shared operating-band compatibility;
- qualified zero-span frame/subframe energy periodicity; and
- cross-channel paired activity as supporting, never mandatory, FDD evidence.

The current v8 classifier implements occupied-width morphology, hard
operating-band eligibility, and optional qualified detected-envelope timing. It
does not decode EARFCN or observe a paired uplink/downlink, so the remaining
candidate blocks do not enter its likelihood as protocol evidence.

Frequency tables must come from a versioned complete standards table rather
than an abbreviated hand list. The table is a hard model-domain eligibility
mask, not likelihood evidence or a transmitter-identity rule; private,
translated, test, or mixed signals can remain unsupported or ambiguous.
E-UTRA supplementary-downlink bands are neither an FDD-pair observation nor a
TDD observation. The implementation uses
`standards-operating-band-context-v1`, a versioned transcription of TS 36.101
18.5.0 Table 5.5-1. It requires complete occupied-interval containment with a
bounded RBW edge tolerance and returns every compatible FDD, TDD, or SDL mode
in an overlap. SDL alone does not support a fitted FDD/TDD leaf; an overlapping
paired or shared row remains visible as an additional structural possibility.
This is a model-support mask, not protocol, deployment, survey-prior, or
regulatory-authorization evidence [17].

### 3.4 5G NR FDD and TDD

FR1 is the 410 to 7125 MHz frequency-range category in the cited release; actual
NR operation is restricted to the operating bands listed by 3GPP, not every
frequency in that interval. Subcarrier spacing follows \(15\cdot2^\mu\) kHz.
Frames remain 10 ms with 1 ms subframes; normal-CP slots contain 14 OFDM symbols
[19,20]. NR uses NR-ARFCN and a distinct synchronization raster/GSCN. An SSB
occupies 240 subcarriers over four symbols and may be configured with a 5, 10,
20, 40, 80, or 160 ms periodicity [20-22].

Likewise, SignalLab's 19.08 and 98.28 MHz NR `occupiedBandwidthHz` fields are
nominal allocated RB-grid spans ((106\times12\times15\) kHz and
(273\times12\times30\) kHz), not nominal channel bandwidth or measured
99%-power or regulatory occupied bandwidth.

Useful evidence is width, supported FR1 band/raster context, possible SSB burst
periodicity, and TDD duty/transition structure. More than 20 MHz of contiguous
cellular-like occupancy favors NR, but adjacent or aggregated LTE is an
explicit confuser. LTE and NR at 20 MHz or below, especially with dynamic
spectrum sharing, must be allowed to return `cellular-OFDM-ambiguous`.

FR2 and bandwidths outside the device's measured support are out of domain, not
negative evidence.

TS 38.104 also defines supplementary-downlink and supplementary-uplink bands.
The implemented `standards-operating-band-context-v1` table transcribes the
complete FR1 rows from TS 38.104 18.12.0 Table 5.2-1 and preserves FDD, TDD,
SDL, and SUL modes independently. A supplemental-only row does not support a
fitted FDD/TDD leaf. When it overlaps a paired or shared row, all compatible
modes remain visible and frequency alone cannot determine actual operation.
This structural compatibility is not protocol, deployment, paired-channel, or
regulatory evidence [19]. FR2 starts beyond the tinySA measurement ceiling and
is therefore outside this model's device domain rather than negative NR
evidence.

The current primary-decision policy never promotes an FDD leaf: absence of a
TDD-like cadence is not positive FDD evidence. It can promote an LTE-TDD-like
or NR-TDD-like leaf only when a qualified detected-envelope timing view
contains transition-rate evidence and the leaf also clears the posterior and
sibling-margin gates. Otherwise it collapses the result to LTE-like, NR-like,
or cellular-OFDM-ambiguous. The fitted FDD/TDD leaf posteriors remain useful
diagnostics, but are not all reachable primary labels. Above the 25 MHz scalar
LTE/NR ambiguity boundary, `nr-like` still means only NR-compatible wideband
OFDM morphology, not decoded NR identity; generic wideband OFDM and adjacent
or aggregated carriers remain potential observational equivalents.

The v13 n78 TDD projection similarly pins the engineering schedule
`nr-tdd-7dl-3ul-engineering-v1`: a valid 5 ms, 30 kHz-SCS
`TDD-UL-DL-Pattern` with seven complete downlink slots followed by three
complete uplink slots and no mixed or flexible symbols. SignalLab activates
only the downlink slots. This is one standards-valid, deterministic engineering
choice for the corpus; it is not implied by n78 and is not a universal network
configuration [50,51]. Its exact carrier center is 3,500,010,000 Hz, NREF
633334, on the selected n78 30 kHz band-specific channel raster; that raster is
distinct from the 15 kHz global NR-ARFCN step in this frequency range [52]. The
v13 n3 scenario also distinguishes the ordinary
band-specific 100 kHz channel raster from the 5 kHz global-raster NR-ARFCN step
applicable in n3's frequency range; those quantities must not be conflated [52].

### 3.5 Wi-Fi 802.11

The normative standards motivate the following *candidate evidence hierarchy*
when the necessary observables are actually resolved [24-26]. Source [47] is an
official project-scope record, not normative technical text; sources [27-29]
are retained only as non-normative design history:

| Observation | Finest defensible result |
|---|---|
| 2.4 GHz DSSS/CCK-like burst | HR-DSSS-compatible morphology, not protocol identity |
| Fixed 20 MHz OFDM burst | 20 MHz Wi-Fi-compatible morphology; generic OFDM remains an explicit confuser |
| 40 MHz OFDM | HT-or-later-compatible width evidence |
| 80/160 MHz OFDM | VHT-or-later-compatible width evidence |
| 320 MHz contiguous Wi-Fi-compatible OFDM in the 6 GHz band | EHT-compatible width evidence when the device supports the complete span, still non-identifying without decoded or time-coherent EHT features |
| decoded or time-coherent RU/puncturing structure | HE/EHT-compatible evidence; a swept scalar trace is insufficient |

20 MHz legacy, HT, VHT, HE, and EHT emissions are not uniquely distinguishable
from integrated spectrum shape alone. A 320 MHz observation outside the 6 GHz
band is not an 802.11be 320 MHz channel. RBW resolution alone also cannot undo
sweep time-frequency skew: repeated notches do not establish HE/EHT resource
units or puncturing. That attribution requires a time-coherent capture or
decoded HE/EHT signaling. Packet duration and gaps depend heavily on rate,
aggregation, contention, retries, and load, so they are better family evidence
than generation evidence.

The implemented scalar classifier is deliberately stricter than the candidate
table. Swept integrated power plus a fixed-tune detected-power envelope contains
no decoded preamble, DSSS/CCK correlation, cyclic-prefix measurement, or
qualified cyclostationarity. Its HR-DSSS-like and OFDM-like leaf posteriors are
diagnostic only; the primary result is at most `802.11-compatible channel
morphology · PHY unresolved` (or `unknown`). Exact proprietary DSSS and OFDM
nulls demonstrate why even that result is an evidence-equivalence statement,
not 802.11 protocol or PHY identity.

Its hard structural model-support masks are narrower than the standard:
HR-DSSS-like support is
limited to 2.4--2.5 GHz and 10--30 MHz measured width; OFDM-like support is
limited to 2.4--2.5, 4.9--5.925, or 5.925--7.125 GHz and 8--110 MHz measured
width. A fully observed 160/320 MHz channel exceeds that supported width, while
resource-unit allocation and puncturing are not represented; those cases must
remain unsupported or unresolved.

These masks also omit standardized S1G/sub-1 GHz and DMG/EDMG millimeter-wave
PHYs. Optical 802.11 PHYs are non-RF and outside a spectrum-analyzer classifier.
Their absence is outside this model's domain, never negative evidence about the
wider 802.11 family [24].

### 3.6 Bluetooth

Bluetooth Classic (BR/EDR) uses 79 centers on a 1 MHz raster in 2.4 GHz,
625 microsecond slots, connected-traffic packet types that occupy 1, 3, or 5
slots, and connection hopping up to 1600 hops/s; inquiry and page procedures can
reach 3200 hops/s [30-32]. The
conventional Bluetooth LE physical-channel plan uses 40 centers on a 2 MHz
raster; primary advertising channels are 2402, 2426, and 2480 MHz. Core 6.3
Channel Sounding defines indices 0 through 78 on a separate 1 MHz-derived grid;
72 are allowed RF channels (indices 2--22 and 26--76) [33,34,54]. The current
corpus does not model Channel Sounding, so its absence cannot be used as negative
Bluetooth evidence and the classifier must remain mode-unresolved.

The canonized `bluetooth-classic-connected` replay does not implement the
Bluetooth hop-selection kernel or infer connection state. It chooses each hop
independently from a uniform seeded pseudorandom sequence over the 79 Classic
centers and applies a fixed two-active-slot/one-idle-slot engineering envelope;
neither choice is universal BR/EDR traffic. Its 79 MHz metadata field is the
aggregate edge-to-edge support across the 79 modeled 1 MHz channels (78 MHz
first-to-last center spacing plus one channel width), not instantaneous
occupied bandwidth.

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

LE 1M and LE Coded share 1 Msym/s shaped-binary-FM spectral occupancy closely
enough that this scalar instrument should not separate them. Their packet
formats, coding, and durations differ substantially, but unknown payload,
coding, event context, and uncalibrated detected-power timing make a single
capture non-identifying [33,34,48]. BR/EDR modulation order is likewise
unsupported without richer evidence.

A fixed-frequency tinySA zero-span capture cannot observe a link-wide Classic
slot schedule or an LE advertising event across all three primary channels. It
sees only visits to the tuned Classic channel or the packet sent on one tuned LE
advertising channel. SignalLab must therefore synthesize `classic-slots` and
`ble-advertising-events` power conditional on the recorded tuned frequency. The
resulting envelopes describe channel-local visits or packets, not link-wide
activity, and are not a defensible Classic/LE discriminator by themselves. An
unconditioned envelope or one merely retagged to a detector peak is invalid.

A sealed diagnostic audit of the failed v18 training run exposed a stricter
identifiability problem. The recommended 450-sample capture at 9 kHz lasts
50 ms, or about 80 Classic slots. Under the canonized 79-channel independent
engineering hopper and its two-active/one-idle envelope, 53 or 54 slots are
active depending on phase, so a fixed channel has approximately 0.503--0.509
probability of no same-channel return, 0.346 probability of exactly one return,
and 0.143 probability of two or more returns. The sealed fitting, production,
and tail-calibration diagnostics respectively contained 146/324, 108/216, and
231/432 no-return Classic captures. An independent reimplementation reproduced
all 1,260 cached detected-power traces with maximum absolute error
`1.42e-14`. On held-out sealed diagnostics, a two-component return/no-return
Classic likelihood improved mean log predictive density by about 1.6 nats for
untimed evidence and 1.86 nats for timed evidence, improving more than 90% of
captures. The modeled 20--30 ms BLE advertising schedule has no analogous
empty-window mode in a 50 ms capture, so that diagnostic does not justify a
generic Bluetooth envelope mixture. These sealed captures were used only to
diagnose the failed model assumption; they are neither fitting, calibration,
nor release evidence.

The production remedy is deliberately conservative. Under
`frequency-agile-fixed-tune-envelope-censoring-v1`, the analysis boundary first
validates the physical capture and its schema-4 receipt, including a
domain-separated canonical SHA-256 binding over the complete returned capture
(samples, cadence, requested geometry/controls, RF metadata, source, and
provenance). Receipt issuance rejects root or nested Proxy graphs, retains a
deeply frozen structured-clone snapshot, and feature extraction consumes only
that authority-owned snapshot so hash verification and feature reads cannot
observe different payloads. The boundary then censors all
detected-power envelope features whenever the observed target projection is a
frequency-agile association. Classification uses the association's exact
regional spectrum/history view. The censor depends only on acquisition
geometry, never a truth label, requested hypothesis, posterior, or whether the
fixed-channel trace happened to contain a return. Bluetooth therefore has no
envelope likelihood components or envelope calibration scores in v19. A future
return/no-return or shared-neutral-noise mixture requires a new SignalLab
diagnostic-only event-lineage API that independently discloses the physical
visit process; until that provenance exists, fitting such a latent mixture
would convert receiver censoring into class-positive evidence.

The production capture boundary therefore uses two distinct objects for a
qualified agile capture. The exact latest current raw detector/track member
owns the analyzer tune and physical capture; the already promotion-qualified
agile summary owns the exact eight-look classifier window. A one-look raw
candidate is eligible only through that contemporaneous latest-member binding,
never by itself, and the synthetic summary never acts as a physical target.
The fixed receiver can legitimately observe later channel returns or no return
during the capture. Both outcomes belong to the acquisition-conditioned joint
evidence population; neither a quiet envelope alone nor the projection itself
establishes a common emitter, Bluetooth protocol, or Classic/LE identity.

The production tracker is frequency-local by default and also has a disclosed
`frequency-agile-2g4-activity` association with provenance
`frequency-agile-2g4-activity-v3` and conditional dynamics model
`bayesian-frequency-agile-transition-v3`. Across a strictly ordered full-band
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

Transition model v3 uses an equal mixture of two neutral engineering transition
components: `fullBand79CellChangePrior = Beta(78,1)` and
`threePrimaryChannelChangePrior = Beta(2,1)`. They describe respectively a
79-cell full-band-agile family and a three-primary-channel-agile family.
Neither is a Bluetooth Classic/LE protocol or emitter likelihood. BR/EDR
adaptive frequency hopping can use and remap \(20\leq N\leq79\) usable
channels, while LE connection and secondary-channel maps contain 2--37 used
general-purpose channels. Channel selection, advertising-event channel use or
early closure, packet occupancy, and receiver censoring violate an iid transition interpretation
[32,34]. The mixture is compared with a predeclared *fixed* stationary Bernoulli
likelihood `p_change=0.05`; it does not integrate the stationary likelihood over
the formerly used Beta prior. Exact dynamic programming over transition counts
gives a sequential false-promotion probability of
`1.3657385209e-5` through 96 positive looks under that independent fixed-5%
null. The computation omits the separate minimum-three-resolution-cell guard,
so it is a conservative upper bound inside the declared transition model. It is
not a physical false-association guarantee and does not cover correlated
receiver artifacts, nonstationary traffic, or unrelated emitters merged by the
provisional association.

The returned evidence exposes separate full-band and three-primary-channel log
marginals plus `primaryChannelCenterHitCount`. Both marginals are functions of
the same change/no-change transition counts; the primary-center hit count is
diagnostic provenance, not advertising-event or protocol evidence.

The transition Bayes factor does not use primary-center hits. Separately, the
classifier's regional spectrum/history feature set includes
`history.bleAdvertisingScore`, an accumulated three-primary-center morphology
score. That score can affect Bluetooth-compatible-versus-unknown likelihood,
but cannot establish Bluetooth protocol, LE mode, or an advertising event; a
proprietary three-channel source can produce the same scalar morphology.

Trainer, tail-calibration, and held-out-validation standard scenarios offer 32
sequential 50 ms opportunities. Full-band 2.4 GHz scenarios offer 96, matching
the association model's bounded opportunity window,
so sparse activity is evaluated over a declared finite horizon rather than a
short standard-geometry slice. Corpus v13 retains
`ble-primary-advertising-engineering-v1`: primary centers 2402, 2426, and 2480
MHz in fixed 37-to-38-to-39 order, 1.5 ms packet-start spacing, 376 microsecond
packet duration, a 20 ms advertising interval, and deterministic seeded
per-event pseudorandom `advDelay` in `[0,10 ms)`. Observation provenance records
the seed. Bluetooth Core allows the used primary-channel subset to be
configured and, for the modeled legacy event, proceeds sequentially through
the used indices; 37-to-38-to-39 is therefore standards-consistent when all
three are used. Events may close early, and extended advertising has different
behavior. The all-three-channel choice, spacing, duration, interval, and
deterministic delay generator are reproducible SignalLab engineering choices,
not universal BLE timing, channel use, PDU length, or event behavior [34].
The scenario's 80 MHz metadata field is the aggregate primary-advertising-
channel support span, not instantaneous occupied bandwidth.
The superseded pre-v19 development regression used eight held-out event-phase
seeds and three interstitial RBWs. In that prior run, at least one RBW acquired
BLE in 5/8 seeds at 24 dB and 8/8 at 32 dB; all 32 admitted BLE first-ready
representatives returned only Bluetooth-like band activity. Those figures are
historical development evidence, not current release evidence; a fresh v19
report must replace them. A failure to admit remains an acquisition limitation,
not negative evidence about an observed device.

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
tests or a hierarchical model justify it. Family priors are independent of
catalog profile counts, so merely multiplying catalog entries cannot increase
NR prior mass. Adding or refitting scenarios or likelihood components can
still change the class-conditional likelihood and posterior, and therefore
requires a new model version and validation.
The implemented class weights are engineering assumptions, not estimates of
ambient class prevalence. The validator therefore applies declared unknown-mass
and family-mass variants that preserve known-class or within-family ratios and
gates synthetic coverage, hierarchical accuracy, incompatible risk, unknown
false acceptance, and decision-change rate. This sensitivity analysis does not
calibrate a field prior; representative physical survey prevalence remains an
unmeasured release limitation.

The implemented `bayesian-observable-equivalence-v8` model extracts 28 scalar
features from repeated sweeps and optional qualified detected-power zero span.
Its 12-leaf denominator contains 11 known leaves and `unknown-signal`.
Regularized empirical multivariate Student-t likelihood components are fitted
only from examples admitted by the production Bayesian detector and two-state
tracker. The checked-in v8 likelihood architecture has 28 ordered feature dimensions and 12 exact leaf class IDs. Its spectrum-only population has 18 source scenarios and 28 likelihood components; each envelope population has 16 scenarios and 26 components because the Bluetooth-like class is structurally unsupported for fixed-tune envelope evidence. Under scenario-components-with-three-shared-covariance-csma-activity-modes-v1, exactly five pinned CSMA sources use three deterministic activity modes while every other supported source/view pair uses one component; source scenarios retain equal within-class mass, CSMA modes use empirical within-source weights, and each decomposed source shares one pooled within-mode covariance. Under frequency-agile-fixed-tune-envelope-censoring-v1, the analysis boundary validates the physical capture and schema-4 receipt first, including its canonical SHA-256 binding of all returned samples, cadence, requested geometry, RF metadata, and provenance, then excludes detected-power envelope features for every frequency-agile association and classifies its exact regional spectrum/history view. This censor is triggered by observed association geometry, never a truth label or requested hypothesis; Bluetooth envelope component and calibration arrays are therefore exactly empty. Component
locations and covariance structure are plug-in estimates, degrees of freedom
are fixed at 7, and the regularization is prescribed by the trainer. This is not
a Bayesian posterior-predictive distribution over uncertain fitted parameters.

Production inference does not use missing-dimension marginalization: v8 selects one exact evidence view, requires its complete finite feature set with no extras, and evaluates only the independently fitted spectrum-only, envelope-untimed, or envelope-timed likelihood population.

The open-set rejection cutoff is a minimum maximum-known synthetic support rank of 0.025; it is an engineering threshold, not a p-value or coverage guarantee.

Each selected evidence view supplies its exact complete fitted dimension set.
An unavailable envelope selects `spectrum-only`; a qualified envelope without
fully qualified cadence selects `envelope-untimed`; and fully qualified timing
selects `envelope-timed`. Production neither marginalizes an arbitrary subset
of a component nor imputes a missing feature. The normalized outputs are model posteriors conditional on the fixed
empirical likelihoods, `engineering-design-class-weights-v1` priors, observed
features, and the structural hypothesis mask. Cellular eligibility is provided
by `standards-operating-band-context-v1`, which pins TS 45.005 19.0.0 clause 2,
TS 36.101 18.5.0 Table 5.5-1, and TS 38.104 18.12.0 Table 5.2-1, including
source URLs and document hashes. It checks the full observed interval with a
bounded RBW edge tolerance and preserves overlapping FDD, TDD, SDL, and SUL
modes. It is not a likelihood, prior, protocol observation, deployment
database, or regulatory authorization. These outputs are not physically
calibrated probabilities. The independently regenerated v19 model-asset
SHA-256 is
`6e25efced19690b599745000fe6b0ea46ca1af67220bb3b2b3b691b9bcf2ffe4`.
Preprocessing is `scalar-observable-features-v7`, representative eligibility is
`observation-only-hypothesis-domain-v5`,
calibration is
`synthetic-independent-branch-view-matched-causal-acquisition-support-rank-detector-conditioned-physical-uncalibrated-v19`,
and decision policy is `observable-open-set-decision-v10`.

Representative-eligibility policy v5 admits the FM leaf only when the observed
scalar view resolves symmetric sidebands (`spectrum.sidebandScore >= 0.2`) or
contains a materially modulated detected-power envelope
(`envelope.rangeDb >= 2` and `envelope.standardDeviationDb >= 0.5`). An FM
source unresolved by the finite RBW/tune/window correctly remains CW-like or
`unknown`; these thresholds define model evidence support, not FM in general.

Known wireless hypotheses also have hard structural model-support eligibility masks. They
test the measured occupied interval—center plus bandwidth with a bounded RBW
edge allowance—against the supported model bands and widths. A center that lies
inside a band cannot rescue an interval extending outside it. These are model
support boundaries, not statements that the standards forbid other allocations;
unsupported standards-compliant observations remain `unknown`.
The broad cellular table and the 5/6 GHz Wi-Fi mask are standards-context
extrapolations beyond the fitted Band 3/Band 38/n3/n78 and 2.4 GHz corpus
centers. They can exclude structurally impossible hypotheses, but they do not
show that likelihoods were empirically fitted or physically validated across
every admitted frequency. Representative physical measurements remain required.

The fitted `unknown-signal` likelihood contains only `unknown-narrow-fsk` and
`unknown-802154`. The remaining corpus scenarios are partitioned before
fitting so that unlike scientific questions are not collapsed into one
"unknown accuracy" number:

- strict unknown holdout: `unknown-impulsive`;
- ambiguity-only stress: `unknown-chirp`, whose finite local fragments may be
  CW-like or FM-like; regular four-/five-line combs; the irregular three-line
  multitone; stationary intermittent 2.4 GHz activity; the simultaneous 1 MHz
  raster; four interleaved channels; and proprietary off-raster FHSS;
- exact observable-equivalence nulls: an instrument spur, independent AM- and
  FM-equivalent line models, generic OFDM matching LTE FDD, LTE TDD, and Wi-Fi
  80 MHz projections, and proprietary DSSS matching the Wi-Fi HR-DSSS
  projection; and
- known acquisition validation only: one-timeslot `gsm-900-tdma`.

The strict holdout must be rejected. Ambiguity and exact-equivalence cases must
produce only a declared compatible class or `unknown`; forcing all of them to
`unknown` would claim information the scalar measurement does not contain. The
chirp is therefore an admitted ambiguity stress case, not an expected
non-admission or a required unknown decision. The
one-timeslot GSM scenario may fail the finite swept-acquisition admission gate;
the separately pinned loaded BCCH/dummy-burst scenario supplies the fitted GSM
morphology. Collisions, overload, ambient emissions, and other unmodeled
confusers remain intended open-set scope without a current physical guarantee.

For each known class, generator-separated calibration converts the maximum
fixed-component radial-tail score into a synthetic support rank by
\((r+1)/(n+1)\). Ranks count reference values less than or equal to the test
score, so ties increase support. Calibration v19 treats each independent branch
acquisition attempt, rather than correlated fragments from that attempt, as the
reference unit. The consecutive-spectrum branch records the minimum support
across all fit-eligible runtime representatives produced in the complete 32-
or 96-look horizon; each qualified-envelope view records the support of its
sole fit-eligible rank-0-integrated-excess capture. Exact per-scenario and per-view score
counts are published by the generated training matrix and independently
reconciled validation report.

“Online-ready” requires current classifier-qualified association evidence, not
merely an association object retained for operator continuity by tracker
hysteresis. A retained association below the current promotion gate remains
visible but produces an insufficient-evidence result and cannot enter the
observation-domain-eligible calibration set.

Tracker readiness is necessary but not sufficient for classifier admission.
The “first-ready representative” is the earliest online-ready opportunity whose
complete provenance can be replayed as one coherent scalar window under the
frozen-origin and later-look uniqueness rules. A runtime window unavailable for
one of the typed evidence reasons raises `ObservableEvidenceUnavailableError`
and returns primary `unknown` with `insufficient-evidence`. During deterministic
fitting and validation, only the declared retryable non-unique-history or
insufficient-ROI-bin reasons are counted and may continue to the first later
provenance-available opportunity. Missing required coherent provenance,
duplicate IDs, contradictions, and other malformed evidence remain hard
validation errors rather than being downgraded to ordinary uncertainty.

The spectrum-branch per-attempt minimum is a pointwise-conservative lower
reference for any spectrum member: a member's rank against attempt minima
cannot be smaller than the corresponding attempt-minimum rank. Each envelope
view instead uses its independent branch's sole qualified physical capture.
Model metadata names this relationship
`spectrum-member-dominates-independent-branch-attempt-min-envelope-is-independent-sole-capture-v3`.
That deterministic ordering is not a sampling theorem. The fixed, stratified nuisance grids and
pooled scenario templates are not exchangeable operational samples, so
standard conformal finite-sample coverage does not apply [41]. Metadata records
`empirical-synthetic-reference-only-no-exchangeability-or-coverage-guarantee-v1`.

Inference selects the matching view, takes the maximum class-conditional
synthetic support rank across eligible known classes, and rejects below the
engineering cutoff 0.025. On support rejection the primary result is `unknown`
with confidence zero and explicit `synthetic-support-rank` value and cutoff;
ranked candidate model posteriors are retained only as diagnostics. The rank is
not a p-value, posterior-predictive probability, physical receiver calibration,
or coverage guarantee for ambient RF. Chow's rule maps an abstention cost to an
acceptance threshold [35], but does not solve unknown-class or open-set
recognition; Scheirer et al. formalize that separate problem [42].

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
`bayesian-frequency-agile-transition-v3` dynamics model integrates an equal
mixture of the neutral `fullBand79CellChangePrior = Beta(78,1)` and
`threePrimaryChannelChangePrior = Beta(2,1)` engineering Beta-Binomial
marginals against the fixed stationary `p_change=0.05` Bernoulli
likelihood, conditional on positive, unambiguous observations. It requires at
least eight positives across at least three
resolution cells and uses a maximum 96-opportunity window with explicit 0.99
promotion and 0.90 retention probabilities. Occurrence and duty probability
deliberately cancel between its agile and stationary hypotheses; it does not
invent an SNR model. The association carries a separate bounded region, source sweeps, local
detector evidence, and both model IDs. Feature extraction may use it only as
broad band-activity evidence, never as an emitter, link, hop sequence, or
advertising-triplet identity.

The separate `regular-spectral-component-activity` association is likewise
classification provenance, not a merged detection. It starts only from at
least three independently admitted, simultaneous narrow local tracks. The
`regular-spectral-component-lineage-v2` model retains a stable allocated
non-identity lineage only across exact looks with compatible frequency lattices,
overlapping observed support, and at least one resolved component center in
common. Each look records and independently replays
its exact member-track IDs, current hull, spacing, lattice anchor, and immutable
source sweep; the public member list and region always describe the latest
look. It abstains when an irregular interior component or overlapping regular
hypotheses make membership ambiguous.
Its miss counter and expiry are independent of local track persistence, so
expiry removes only the group evidence. Feature extraction requires exactly the
latest eight admitted association looks. The UI computes one classification per
association and maps it back to all member rows while continuing to display each
member as a local detection. Neither the association nor its result establishes
that the lines share an emitter.

The third classification-only path, `multicomponent-swept-region-activity`, uses
`multicomponent-swept-region-v2` to represent a sweep-fragmented regional
hypothesis without converting it into a detection. Each look requires at least
four local members, and every member must independently satisfy the production
`bayesian-exponential-multiscale-cfar-v3` local admission with its complete
selected-local-region evidence. A look is eligible through one of two explicit
routes: a selected multiscale classification region contains the current
observed member hull within `1.1 × max(RBW, bin width)` tolerance, recorded as
`selected-multiscale-region-containment-not-emitter-identity`; or the resolved
components satisfy the bounded 1-to-3-step raster/edge rules, recorded as
`resolved-component-raster-not-emitter-identity`.

The public association region is always the latest look's complete observed
hull, and its current member list is exactly the latest look's members; neither
is a cumulative union. A prior observation remains in the latest exact
eight-look lineage only when its complete sweep geometry matches, its region
has padded intersection-over-union of at least 0.75 with the new/latest region,
and at least one component center remains within
`max(2 × RBW, 5 × bin width)`. Geometry-changing, disjoint, or unrelated
history is pruned. A lineage may reconnect only within the tracker release
window; missed evidence remains unqualified, and reacquisition after expiry
starts a new association ID.
This dynamic membership is regional classification provenance only. A zero-span
capture remains bound to the selected local member/tune and cannot be promoted
into time coverage for the regional hull. The association claims neither
simultaneity, a common generating process, nor emitter identity.

Feature extraction accepts only provenance-bound coherent sweeps with
matching frequency grid, RBW, attenuation, detector, gain state, device, and
firmware/execution identity; zero-span evidence is also bound to the target
detection and device identity. Because a detector centroid may be fractional
while the detected-power contract is integer-Hz, one shared projection chooses
the nearest advertised tuning-lattice point (the higher point on an exact tie),
rejects non-finite or out-of-range values, and uses that identical projected
frequency for synthesis, the admitted request, the capture, and provenance.
The extractor uses every admitted source sweep
inside the applicable provenance region for a fixed most-recent eight-admission
window. Trainer, tail-calibration, and held-out validation standard attempts
each offer 32 sequential opportunities; a full-band 2.4 GHz attempt offers 96
in every branch so sparse frequency-agile
activity has a declared finite horizon. Longer track history is not pooled into look-count-
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
could not resolve load-dependent 1.733 kHz GSM slot-boundary structure without
aliasing; a fixed GSM timeslot instead recurs at approximately 216.7 Hz. LTE's
0.5 ms slot has a 2 kHz reciprocal time scale; it is not a 2 kHz resource-grid
boundary or a guaranteed detected-power cadence.
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

SignalLab's 34-profile UI catalog contains 12 public canonized observable
profiles backed by the same executable known-scenario source as the corpus.
The other 22 visual/standards profiles remain UI fixtures and are not the
classifier's physical training truth or posterior taxonomy. Named test models
whose required power-balanced allocation, per-slot PRB sequence, subslot/slot
timing, or SBFD spectral partition is not implemented are absent from the
selectable catalog; that absence is unsupported capability, not negative
family evidence. SignalLab has the
separate immutable `observable-scalar-corpus-v13`, with 35 canonical scenarios
(17 known and 18 unknown/confuser) at commit
`03bc13eb9d5efcfc5f2f9c1792042f670b71ef9a`. Its canonical eight-artifact
source manifest has SHA-256
`38288f0e0437dbb687674308afecb4f30adadc9e93ea7abad3b8bf13d80ec918` and pins
the following lexical path/digest sequence:

- `package-lock.json`: `5b9b9620ee2667aab2ef18eb12514557511d9be20b9eff5e06a54ed213c4a6b0`;
- `package.json`: `e278e52ed74d12e959f02666fc64cad6a372bdc1e9551bf1317d341f663b440f`;
- `src/canonical-timing.ts`: `6537edce440fe5ea11dc87e72cf8bd270bb77b6990bcf10b2443a2ddceb67b21`;
- `src/catalog.ts`: `24575b0a0c73853abb52e245a567d96d3cca835a48217619f6e105235519989a`;
- `src/classification-corpus.ts`: `220a83afe368c2ad7baffd305945e413a3e4e5e9d6feadac26065a0add2c3d09`;
- `src/contracts.ts`: `37c38eddb62c345dfa41e9d53ea327030123e804ab74b152e439dcd8c7df6daa`;
- `src/source-provenance.ts`: `4dd372449fedf70b69f1e9f2250598767e057abb3d5ceeab5373126146b2f7df`;
- `src/waveforms.ts`: `1af5cf7dd59fab899332192df7ae77b13aabd482b3050ee685a7c4d559978584`.

The six TypeScript files are the complete relative import closure rooted at
`src/classification-corpus.ts`; the package manifest and lockfile pin executed
dependency semantics. Generation and independent validation require a clean
SignalLab index/worktree and prove that every path is a regular non-symlink
tracked file whose bytes match the pinned Git blob.
The trainer runtime is pinned independently of those source bytes. Before any
private build, the launcher reads `.node-version` and requires its own
`process.version` to equal `v22.23.1`; the privately built trainer independently
verifies the attested identity `exact-repository-node-version-v1`, Node
`22.23.1`, and V8 `12.4.254.21-node.56`. The generated training matrix and the
validation acceptance/report must carry that exact identity. npm `10.9.8` is a
separate developer/CI tooling pin, not model-runtime provenance.
The completed v19 release evidence satisfies the acquisition contract below.
The fitted and independently regenerated acquisition matrix uses SignalLab's 450-point recommended-span grid in two independent production-gate sessions under independent-no-auto-spectrum-and-qualified-rank-0-integrated-excess-envelope-sessions-v2. The no-automatic-capture consecutive-spectrum branch starts its twelve profiles at source looks 0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, and 416 and spans source indices [0, 512); the qualified-envelope branch starts them at source looks 0, 33, 66, 99, 132, 165, 198, 231, 264, 297, 330, and 427 and spans [0, 524), with at most one detected-power capture after rank-0 runtime admission. Under preferred-then-current-source-sweep-integrated-excess-power-physical-or-qualified-agile-member-target-v4, ordinary targets are active physical rows with zero missed sweeps. The only candidate-state exception is the exact latest raw detector/track member cited by the latest exactly-one opportunity of a current, promotion-qualified, zero-miss frequency-agile association. The synthetic activity summary never owns the hardware capture, and arbitrary candidates, stale members, retained summaries, and ambiguous opportunities remain ineligible. An autonomous branch ranks eligible raw rows by current-source-sweep integrated excess power under current-source-sweep-integrated-excess-power-v1; it integrates positive linear power above the robust floor over complete physical cells and normalizes by actual RBW. The stable representative key and raw ID are exact-power tie-breaks. Association qualification controls only whether the narrow agile projection exists, never priority among eligible rows. Truth labels, class-domain eligibility, feature readiness, and classifier posteriors never influence that ranking. After ranking, the controller tunes and binds the capture to the raw row while receipt schema 4 projects the exact eight-sweep classifier window to its evidence representative and binds the complete returned capture with domain-separated canonical SHA-256. For an agile projection the receiver remains fixed on the selected physical channel and may observe later returns or no return; it never follows the hop and proves neither a common emitter nor Bluetooth protocol or mode identity. Under frequency-agile-fixed-tune-envelope-censoring-v1 the valid capture and receipt remain audited, but every frequency-agile fixed-tune envelope is excluded from classifier features and the exact regional spectrum/history view is used; this observation-geometry censor is independent of truth or requested hypothesis. Later spectra continue at the next source look. Held-out validation begins at source look 512 for consecutive spectrum and 524 for qualified envelope. Every envelope admitted to a classifier likelihood requires an analysis-issued capture receipt and is explicitly qualified as receipt-verified-provenance-bound-runtime-admitted-physical-capture-v5; receipt-free or runtime-unadmitted captures cannot enter Bayesian envelope metrics. Public detected-power synthesis uses the generator-internal 100 kHz filter; measured detected-power RBW remains unavailable and is never classifier evidence.

The schema-4 receipt is minted only by the analysis boundary after independent replay and candidate ranking, is deeply frozen and process-authorized, and is revalidated against the representative, admitted tune, ordered eight-sweep window, and domain-separated SHA-256 of the complete canonical returned capture before envelope features are admitted. The digest binds every power sample, cadence and requested-geometry/control field, RF metadata/qualification, source field, and provenance field; an authorized receipt fails closed against any substituted finite capture.

The `zero-span-capture-canonical-json-v1` encoding accepts only strict plain
objects and ordinary dense arrays with enumerable own data fields, recursively
sorts object keys, preserves array order, and JSON-encodes finite primitives.
It rejects non-finite numbers, array holes/subclasses/decorations, accessors,
symbols, cycles, extra root fields, and missing or non-enumerable required
fields. Optional `undefined` and absence are the same typed absence. The hash
input is the UTF-8 domain `tinysa-detected-power-capture-payload-v1\0` followed
by that canonical JSON.

The App zero-span action enters a Bayesian envelope view only when the capture is bound to an analysis-issued receipt for a current runtime-admitted target, exact admitted tune, and exact eight-sweep evidence window. Receipt qualification is necessary but not sufficient: under frequency-agile-fixed-tune-envelope-censoring-v1, every fixed-tune frequency-agile capture remains excluded from Bayesian envelope inference and the exact spectrum view is used instead. Any other receipt-free or runtime-unadmitted capture may feed only the separate envelope heuristic.
Its component-fit exclusions are the strict holdout, ambiguity-only cases,
exact-equivalence nulls, and the acquisition-only one-timeslot GSM case listed
in Section 4. Those partitions are immutable model metadata and are audited
against the validator's independent pinned lists.

The current checked-in scenario schema records the scenario and truth-class
IDs, allowed observable classes, family and label, center/occupied/span
geometry, scalar spectrum and envelope model IDs, numeric model parameters,
optional raster/duplex context, an ordered source-reference list
(organization, specification, revision, clause, and URL), and the
non-conformance disclosure. Each generated scalar observation additionally
records the corpus version, qualification, seed/look index, swept-power and
detected-power vectors, sweep/RBW/tune/sample-period geometry, the same source
basis, and the disclosure.

The following are planned corpus requirements, not fields recorded by the
current scenario or observation schemas:

- a separate stable evidence-class identifier and formula-level provenance;
- a standards-version manifest with per-table hashes and artifact digests;
- explicitly complete truth and nuisance parameter manifests beyond the
  current scenario parameters;
- generator identity/version, sample rate, duration, and generated-asset
  SHA-256 digest;
- optional I/Q truth retained only to derive scalar observations;
- a complete, explicit instrument-response configuration and separately
  declared expected feature qualifications;
- a general provenance kind including physical captures; and
- for physical captures, generator, device, session, environment, and
  calibration-chain identifiers.

Version 13 retains the acquisition-time behavior introduced in version 7. The
fixed one-of-eight GSM and seeded CSMA-like Wi-Fi engineering envelopes, plus
the pinned LTE and NR TDD schedules, gate each spectrum bin at that bin's actual
visit time, rather than drawing a continuous channel and applying activity only
to zero span. These scalar schedules are not decoded MAC traffic or protocol
likelihoods. The corpus separates a one-timeslot GSM acquisition stress case from
a loaded BCCH/dummy-burst carrier suitable for fitting. Its AM and FM zero-span
captures coherently combine the modeled spectral components through the
explicit detected-power synthesis filter at the actual tune frequency;
off-center or narrow-filter captures can therefore become CW-like without
fabricating an ideal baseband envelope. Version 13 separates that
generator-internal filter width from swept-spectrum RBW: the production replay
uses 100 kHz, records it only as reproducibility provenance, and keeps measured
detected-power RBW unavailable. Version 13 also retains the centralized LTE configuration
0/special-subframe-7, NR seven-downlink/three-uplink, and seeded BLE advertising
schedules described above and records their engineering, non-universal scope.
Exact-equivalence scenarios deliberately reproduce the same admitted scalar
observations from a different source story.

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
analytic Gamma shapes 1/2/6/12, and independent or three-cell perfect-block-
correlated noise through the exact declared permissive high-candidate-load
segmentation path. A lower segmentation threshold can merge components, so
this path is not claimed to be a mathematical superset of production
segmentation. It runs 8,000 null sweeps for each of the eight predeclared
shape/correlation configurations: 64,000 sweeps, 28.8 million nominal cells,
and 19.2 million correlation-adjusted effective cells. Shape 1 supplies exact
exponential marginal draws; correlation width 1 is the exact iid cell model,
while width 3 empirically assesses the detector's RBW effective-count
approximation under a perfect-block analytic correlation family. Shapes above
1 are lower-variance averaged-power analytic stress variants, not a general
proof that every nonlinear detector path is conservative. A Bonferroni
simultaneous-family 95% Wilson interval, not eight
unadjusted pointwise intervals, must place every configuration's sweep false-
alarm upper bound at or below the declared 0.001 ideal-model target. The trial
count is itself an acceptance gate; reducing it cannot silently weaken the
interval.

The final nominal run observed zero detections in all 64,000 null sweeps. The
Bonferroni simultaneous-family 95% upper Wilson bound was 0.000933724 for every
predeclared configuration, below the 0.001 target. These are 28.8 million
nominal cells but only 19.2 million correlation-adjusted effective cells; the
sweep, not a nominal bin, is the false-alarm trial.

The one-look detection matrix uses the exact production sweep-local detector
settings before runtime tracker promotion. A success means that a returned
threshold-connected local candidate contains the declared center. Its centered
flat linear-power mean shift spans one or eight RBWs at SNR
0/5/10/15/20/25/30 dB. Each alternative occupies
`round(widthRbw * binsPerRbw)` frequency-grid bins. This is an analytic
observation-domain alternative, not a synthesized RF waveform, protocol,
receiver calibration, sensitivity, or field-strength claim. Its support is
symmetric about the frequency-grid midpoint; when an odd support meets an
even-point grid, the declared tie policy selects the upper center cell. Common
random numbers provide pointwise monotonicity, with pointwise 95% Wilson lower-
bound gates of
0.15/0.60/0.75/0.90 at 15/20/25/30 dB respectively. A separate audit requires
detector topology, predictive tails, and posteriors to be invariant to
a common linear-power gain within numerical tolerance. Sloped backgrounds,
in-span gain discontinuities, declared spurs, impulses, and compound heavy-tail
clutter are reported separately as out-of-model susceptibility; they are never
laundered into the stationary common-scale false-alarm claim. These are
analytic simulations and acceptance requirements, not tinySA receiver
calibration.

A separate two-look matrix instantiates a fresh production `SignalTracker` for
each trial, passes two ordered independent analytic looks through the
production detector and tracker, and counts success only when an active runtime
track contains the declared center after look two. Its pointwise 95% Wilson
lower-bound gates at 15/20/25/30 dB are
0.0225/0.36/0.5625/0.81, the squares of the predeclared independent-look
one-sweep gates. Both matrices use common random numbers across SNR for their
paired monotonicity audits. Every Pd interval and gate is pointwise for one
shape, correlation width, alternative width, and SNR cell; neither matrix makes
a simultaneous-family Pd confidence claim. Both are conditional on the fixed
0.01 local-region prior, 0.99 posterior gate, and declared 18 dB-scale truncated
positive-power-gain mixture. This validator does not establish detector-prior
sensitivity or physical signal prevalence.

The last published one-look analytic-alternative run comprised 56,000 trials.
The worst observed pointwise 95%
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
including the provenance-bearing frequency-agile, regular-component, and
multicomponent swept-region classification associations. They do not use a known-presence or max-hold
oracle. Trainer fitting, tail calibration, and held-out validation supply 32
sequential 50 ms opportunities for standard geometry; full-band 2.4 GHz
association scenarios supply 96. Fitting, calibration,
and scoring use exactly the latest eight admitted local or association sweeps.
Admission misses and conditional classification results are reported separately.

The final regression matrix uses held-out nuisance seeds 13001, 13019, 13037, 13063, 13081, 13099, 13127, and 13151; SNR 6/10/16/24/32 dB; and interstitial RBW divisors 15.5/44/98 rather than a fitted or support-calibration grid point. It audits the fitted unknowns, one strict unknown holdout, eight ambiguity-only cases, seven exact-equivalence pairs, and the acquisition-only one-timeslot GSM case separately.
The strict holdout must
reject; ambiguity and exact-equivalence decisions must stay within each
scenario's declared compatibility set; and no disallowed false acceptance is
permitted. Proper scores are computed only for identifiable, observation-domain-eligible
examples. Expected acquisition non-admission for the one-timeslot GSM case is
reported rather than converted into a wrong-class event; the chirp remains an
admitted CW/FM/unknown-compatible ambiguity stress case. All nominal LTE/NR
cases at 20 MHz or below must preserve the deliberate cellular-OFDM ambiguity.

The following figures are retained from the superseded pre-v19 development run
only; they are unavailable as current release evidence until a fresh,
independently regenerated v19 report replaces them. That run covered 4,200 acquisition attempts, admitted 2,145 (0.510714), and
produced 9,944 unique first-ready representatives. Conditional hierarchical
accuracy was 0.985318, known coverage 0.993796, covered-known hierarchical
accuracy 1.0, known top-leaf accuracy 0.993996, and minimum high-SNR
known-class hierarchical accuracy 0.9875. On 5,525 singleton-truth,
observation-domain-eligible proper-score samples, fitted-template log loss was 0.0142141,
multiclass Brier score 0.00825527, and expected calibration error 0.00192378.
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

The cited 3GPP documents currently span several releases. Stable facts remain
traceable to the cited clauses, but this bibliography is not a coherent model
baseline. Each future corpus/model release must pin the per-claim standards
manifest described above rather than infer compatibility from this mixed list.

## Primary, official, and historical sources

1. [Tektronix, What is a spectrum analyzer?](https://www.tek.com/en/documents/primer/what-spectrum-analyzer-and-why-do-you-need-one)
2. [tinySA FAQ](https://tinysa.org/wiki/pmwiki.php?n=Main.FAQ)
3. [tinySA RBW](https://tinysa.org/wiki/pmwiki.php?n=Main.RBW)
4. [tinySA scanning speed](https://tinysa.org/wiki/pmwiki.php?n=Main.SCANNINGSPEED)
5. [tinySA Ultra specification](https://tinysa.org/wiki/pmwiki.php?n=TinySA4.Specification)
6. [Neyman and Pearson, 1933](https://doi.org/10.1098/rsta.1933.0009)
7. [Finn and Johnson, *Adaptive detection mode with threshold control as a function of spatially sampled clutter-level estimates*, RCA Review 29, pp. 414--464, 1968](https://www.rsp-italy.it/Electronics/Magazines/RCA%20Review/_contents/RCA%20Review%201968-09.pdf)
8. [Rohling, ordered-statistic CFAR, 1983](https://doi.org/10.1109/TAES.1983.309350)
9. [Weinberg, Bayesian predictive CFAR, 2019](https://doi.org/10.1049/iet-rsn.2018.5635)
10. [Urkowitz, energy detection, 1967](https://doi.org/10.1109/PROC.1967.5573)
11. [Carson, *Notes on the Theory of Modulation*, 1922](https://doi.org/10.1109/JRPROC.1922.219793)
12. [Armstrong, frequency modulation, 1936](https://doi.org/10.1109/JRPROC.1936.227383)
13. [Azzouz and Nandi, automatic modulation recognition, 1995](https://doi.org/10.1016/0165-1684(95)00083-P)
14. [3GPP TS 45.005](https://www.etsi.org/deliver/etsi_ts/145000_145099/145005/19.00.00_60/ts_145005v190000p.pdf)
15. [3GPP TS 45.002, TDMA timing and burst structures](https://www.etsi.org/deliver/etsi_ts/145000_145099/145002/19.00.00_60/ts_145002v190000p.pdf)
16. [3GPP TS 45.008 clause 7.1, continuous BCCH-carrier and dummy-burst requirements](https://www.etsi.org/deliver/etsi_ts/145000_145099/145008/19.00.00_60/ts_145008v190000p.pdf)
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
27. [IEEE HE resource-unit design discussion (historical, non-normative)](https://www.ieee802.org/11/email/stds-802-11-tgax/msg01279.html)
28. [IEEE EHT spacing design discussion (historical, non-normative)](https://www.ieee802.org/11/email/stds-802-11-tgbe/msg02717.html)
29. [IEEE EHT RU/MRU design discussion (historical, non-normative)](https://www.ieee802.org/11/email/stds-802-11-tgbe/msg03935.html)
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
40. [Wald, *Statistical Decision Functions*, 1950](https://books.google.com/books?id=nq0gAAAAMAAJ)
41. [Shafer and Vovk, conformal prediction tutorial, 2008](https://www.jmlr.org/papers/v9/shafer08a.html)
42. [Scheirer et al., *Toward Open Set Recognition*, 2013](https://doi.org/10.1109/TPAMI.2012.256)
43. [Wei and Mendel, maximum-likelihood modulation classification, 2000](https://doi.org/10.1109/26.823550)
44. [Swami and Sadler, cumulant-based modulation classification, 2000](https://doi.org/10.1109/26.837045)
45. [Dandawate and Giannakis, tests for cyclostationarity, 1994](https://doi.org/10.1109/78.317857)
46. [Dobre et al., automatic modulation classification survey, 2007](https://doi.org/10.1049/iet-com:20050176)
47. [IEEE P802.11bk PAR, stating 802.11be 320 MHz operation in the 6 GHz band](https://www.ieee802.org/11/PARs/P802.11bk.pdf)
48. [Bluetooth LE regulatory aspects and PHY-duration overview](https://www.bluetooth.com/wp-content/uploads/2023/03/bluetooth-le-regulatory-aspects-document.pdf)
49. [3GPP TS 36.211 19.3.0, clause 4.2 and Tables 4.2-1/4.2-2](https://www.etsi.org/deliver/etsi_ts/136200_136299/136211/19.03.00_60/ts_136211v190300p.pdf)
50. [3GPP TS 38.331 19.1.0, clause 6.3.2](https://www.etsi.org/deliver/etsi_ts/138300_138399/138331/19.01.00_60/ts_138331v190100p.pdf)
51. [3GPP TS 38.213 19.3.0, clause 11.1](https://www.etsi.org/deliver/etsi_ts/138200_138299/138213/19.03.00_60/ts_138213v190300p.pdf)
52. [3GPP TS 38.104 19.4.0, clause 5.4.2.3](https://www.etsi.org/deliver/etsi_ts/138100_138199/138104/19.04.00_60/ts_138104v190400p.pdf)
53. [3GPP TS 45.004 19.0.0, GSM/EDGE modulation formats and symbol rates](https://www.etsi.org/deliver/etsi_ts/145000_145099/145004/19.00.00_60/ts_145004v190000p.pdf)
54. [Bluetooth Core Specification 6.3, Channel Sounding](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Core_v6.3/out/en/low-energy-controller/channel-sounding.html)
