# SignalLab measurement and stimulus ownership notice

Status: ownership shim; updated for trio composition v7 on 2026-08-01.

Waveform descriptors, the 44-profile closed catalog, AWGN/Rayleigh scalar-channel behavior, explicit receiver-I/Q impairments, high-level synthetic measurements, and stimulus intent are owned by the independent `../Atom-SignalLab` repository. Twelve public observable profiles share SignalLab's executable canonical-scenario source with the classifier corpus; the remaining 32 profiles are not classifier truth. Its normative boundary is [SignalLab CONTRACTS](../../Atom-SignalLab/CONTRACTS.md).

The closed catalog omits named test models whose required power-balanced
allocation, per-slot PRB sequence, subslot/slot timing, or SBFD spectral
partition is not implemented. Those omissions are unsupported capability, not
negative evidence about the standards families.

Atomizer does not duplicate SignalLab synthesis code. Its `signal-lab` driver bundles SignalLab's platform-neutral service and strict version-3 contract directly into both editions. It admits bounded swept-spectrum and detected-power results qualified `synthetic-visual-projection`, plus bounded deterministic `cf32le` complex-I/Q for all 44 closed profiles.

The I/Q catalog has three explicit classes:

- 31 content-addressed fixed digital artifacts. Exact clean native bytes are `independently-verified-digital-baseband`; clean resampling, fractional delay, or frequency translation is `derived-from-independently-verified-digital-baseband`.
- Two Bluetooth long-dwell unbounded native-rate compositions. They carry no canonical artifact, cyclic period, or terminal capture bound; clean output remains `standards-derived-complex-baseband` and derived FIR support zero-extends only before session origin.
- CW, AM, FM, and five constellation references are rate-flexible analytic laboratory generators qualified `analytic-complex-baseband`.
- Three custom standards builders are rate-flexible engineering projections qualified `standards-derived-complex-baseband`.

Every non-clean receiver-I/Q preset is `receiver-impaired-complex-baseband`, regardless of its clean source. Each fixed profile declares its native sample rate, signal bandwidth, profile signal center, canonical RF reference, native carrier offset, native minimum capture bandwidth, and cyclic or one-shot replay bounds. Each result separately declares output sample rate, capture bandwidth, output carrier offset, RF tune, operator placement, and an exact transform receipt. The receipt binds the signed source window, rational output timing, resampling/fractional-delay/frequency-translation/impairment operations, and source/output SHA-256 values. Atomizer hashes the decoded payload and rejects any mismatch.

Capture bandwidth is a symmetric passband about `rfTuneCenterHz`, so keeping an artifact's native carrier where it natively sits costs `2 * abs(nativeCarrierOffsetHz) + signalBandwidthHz` of it. That is the transport's `nativeMinimumCaptureBandwidthHz`: 63 MHz for Bluetooth BR at -31 MHz and 31 MHz for Bluetooth LE at -15 MHz, and the plain signal bandwidth for every zero-offset artifact. Atomizer stages a selected profile at that floor so the default capture returns exact native bytes. A narrower but still signal-wide request stays legal; the producer translates the carrier to DC, returns different bytes, emits a frequency-translation receipt operation, and downgrades to `derived-from-independently-verified-digital-baseband`. Atomizer rejects any result whose capture bandwidth cannot symmetrically contain its own reported output carrier offset and signal support.

Digital qualification applies to the generated I/Q bytes and their declared construction. It does not require an antenna, but it also does not claim RF emission, antenna behavior, calibrated power, regulatory compliance, interoperability, product certification, or over-the-air conformance. Detected-power acquisition separately requires one safe-integer center frequency on the advertised 1 Hz lattice; the producer returns that exact value and receiver-filters the selected scalar source model at the requested tune. This SignalLab→Atomizer measurement edge is active, and exact candidate `signal-lab:default` is the factory default when no instrument preference exists. The selected profile remains source status/capability state and is never copied into measurement, detector, classifier metadata, or export evidence. Connection or contract failure is terminal for that admission attempt and never falls back to a tinySA source.

The active measurement edge does not apply stimulus to executable firmware. SignalLab→Firmware remains a separate future `SignalLabStimulusIntent` edge with status `reserved-not-connected`; no current process supplies a Firmware-owned sink.

The physical ZS407 and executable twin are separately selectable sources behind Atomizer's `tinysa-zs407` driver. The twin is owned by `../Atom-Firmware`, executes pinned firmware over `renode-monitor-bridge`, and explicitly does not model USB transactions. Neither source is an automatic substitute for SignalLab or for the other TinySA source kind.

The cross-repository source of truth is [trio-composition-v7.json](../contracts/trio-composition-v7.json). Any activation of a SignalLab stimulus sink requires a new coordinated trio contract version.
