# Bayesian detection and waveform classification research basis

Status: implementation design and validation contract  
Updated: 2026-07-13

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
Bluetooth Classic-like, Bluetooth LE-like, and unknown. A more specific leaf is
permitted only when a documented feature actually distinguishes it.

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
- an estimated effective independent-cell count; and
- the distinction among false alarms per cell, sweep, event, and hour.

### 2.3 Temporal inference

Repeated sweeps are correlated. Blindly multiplying their Bayes factors makes
the posterior overconfident. Track state should use a two-state Bayesian filter:

\[
q^-_t=p_{11}q_{t-1}+p_{01}(1-q_{t-1}),
\]

\[
q_t=\frac{L_1(D_t)q^-_t}
{L_1(D_t)q^-_t+L_0(D_t)(1-q^-_t)}.
\]

Until transition and measurement models are fitted from sessions, accumulated
looks are engineering evidence, not a calibrated track probability.

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
can therefore carry slot/frame cyclostationary evidence; the approximately
1.733 kHz slot cadence is useful when sample timing and analog bandwidth support
it. BCCH/dummy bursts can make a carrier appear continuously occupied, so the
absence of gaps is not negative GSM evidence [16].

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

Scalar power supports the following hierarchy [24-29]:

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

### 3.6 Bluetooth

Bluetooth Classic uses 79 centers on a 1 MHz raster in 2.4 GHz, 625 microsecond
slots, 1/3/5-slot packets, and connection hopping up to 1600 hops/s; inquiry and
page procedures can reach 3200 hops/s [30-32]. Bluetooth LE uses 40 centers on a
2 MHz raster. Primary advertising channels are 2402, 2426, and 2480 MHz [33,34].

Power-only results are therefore:

- repeated 1 MHz-raster hopping: Bluetooth-Classic-like, with proprietary FHSS
  as an explicit confuser;
- activity on all three primary advertising centers with event timing/jitter:
  strong Bluetooth-LE-advertising-like evidence;
- 2 MHz-raster connected hopping: Bluetooth-LE-like; and
- broader occupancy: probabilistic LE 2M evidence only.

LE 1M and LE Coded are generally power-equivalent; unknown payload length makes
a single packet duration non-identifying. BR/EDR modulation order is likewise
unsupported without richer evidence.

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
- history: fixed-channel persistence, hop transitions, paired-channel or
  advertising-triplet evidence; and
- context/acquisition: band/raster priors, RBW, sweep skew, detector, noise
  uncertainty, device and observation duration.

Within-block features may use a multivariate Student-t likelihood or an
empirical density. Blocks may be combined only when conditional-independence
tests or a hierarchical model justify it. Family priors are independent of the
number of catalog profiles, so adding 40 NR fixtures cannot inflate the NR
posterior.

The unknown hypothesis is a proper member of the normalization and includes
unsupported modulation, contaminated/instrument states, collisions, hopping
confusers, chirps, 802.15.4, generic OFDM, overload, spurs, and real ambient
emissions. Closed-class maximum probability is not an open-set detector.
Posterior-predictive typicality supplies an additional rejection gate. Chow's
reject rule maps the abstention cost to an acceptance threshold [35].

Any fitted temperature or probability calibration is learned on untouched,
session-grouped validation data. Temperature scaling can calibrate scores; it
does not transform an arbitrary score into a likelihood [36].

## 5. Acquisition qualification

Features are `available`, `censored`, or `unsupported`; missing evidence is
never silently scored as evidence against a class.

At minimum, every classification stores:

- actual start/stop/RBW, nominal bin width, detector, attenuation and gain;
- sweep duration and, when available, per-bin timing;
- zero-span center, RBW, actual sample period, duration and completeness;
- frequency/bandwidth boundary censoring;
- source sweep/capture IDs and device/firmware identity; and
- every feature's qualification reason.

The current 290-point/100 ms default has a nominal 2.9 ksample/s rate and cannot
resolve a 1.733 kHz GSM or 2 kHz LTE energy cadence without aliasing. A nominal
450-point/50 ms request is a useful provisional acquisition, but it remains
unqualified until actual sample timing and detector bandwidth are characterized.

Adaptive acquisition should select the next measurement by expected posterior
information gain. Typical follow-ups are narrower RBW for line/sideband shape,
wider RBW for total envelope power, zero span at center and the documented
quarter-RBW offset, and a window long enough to cover repeated candidate
frames/events.

## 6. SignalLab canonical corpus contract

The existing 79 visual profiles remain UI fixtures. They must not be the
classifier's physical training truth. A separate immutable corpus records:

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

Required canonical positive scenarios cover every class in the executive
conclusion. Hard negatives cover at least noise, 802.15.4, generic OFDM,
proprietary 1/2 MHz FHSS, narrow FSK, OOK, DSB-SC, SSB, PM, chirps, swept
carriers, microwave interference, overload/spurs, adjacent-channel composites,
Wi-Fi/Bluetooth collisions, and multi-emitter mixtures.

Synthetic matrices vary SNR, carrier-bin offset, RBW-to-bandwidth ratio,
burst-to-sweep ratio, sweep phase, AWGN/fading, duration, traffic state, channel
width and mixtures. They verify implementation and identifiability behavior;
they do not calibrate real-world probabilities.

## 7. Validation and acceptance

### 7.1 Detector

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

Report on untouched sessions/devices/environments:

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
2. SignalLab held-out scenarios may claim synthetic-domain performance only.
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

