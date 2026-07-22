# SignalLab measurement and stimulus ownership notice

Status: ownership shim; updated for trio composition v4 on 2026-07-17.

Waveform descriptors, the 34-profile closed catalog, AWGN/Rayleigh channel behavior, high-level synthetic measurements, and stimulus intent are owned by the independent `../Atom-SignalLab` repository. Twelve public observable profiles share SignalLab's executable canonical-scenario source with the classifier corpus; the remaining 22 profiles are visual/standards fixtures, not classifier truth. Its normative boundary is [SignalLab CONTRACTS](../../Atom-SignalLab/CONTRACTS.md).

The closed catalog omits named test models whose required power-balanced
allocation, per-slot PRB sequence, subslot/slot timing, or SBFD spectral
partition is not implemented. Those omissions are unsupported capability, not
negative evidence about the standards families.

Atomizer does not duplicate SignalLab synthesis code. Its `signal-lab` driver bundles SignalLab's platform-neutral service and version-1 contract directly into both editions and admits bounded swept-spectrum and detected-power results qualified `synthetic-visual-projection`, plus bounded deterministic `cf32le` complex-I/Q for all 34 closed profiles. CW, AM, and FM are closed-form laboratory envelopes qualified `analytic-complex-baseband`; the other 31 are standards-derived engineering envelopes qualified `standards-derived-complex-baseband`. Detected-power acquisition requires one safe-integer center frequency on the advertised 1 Hz lattice; the producer returns that exact value and receiver-filters the selected source model at the requested tune. Complex-I/Q independently admits bandwidth from 1 kHz through the requested sample rate, returns at most 65,536 complete samples with exact byte geometry, and declares that the replay channel is not applied. Standards-labelled buffers are not packet-decodable or conformance vectors; a request below a wideband profile's catalogued occupied support yields a disclosed deterministic discrete-time alias projection rather than an alias-free full-channel reconstruction. Framework-generated independently validated assets remain future work. This SignalLab→Atomizer measurement edge is active, and exact candidate `signal-lab:default` is the factory default when no instrument preference exists. The selected profile remains source status/capability state and is never copied into measurement, detector, classifier metadata, or export evidence. Connection or contract failure is terminal for that admission attempt and never falls back to a tinySA source.

The active measurement edge does not apply stimulus to executable firmware. SignalLab→Firmware remains a separate future `SignalLabStimulusIntent` edge with status `reserved-not-connected`; no current process supplies a Firmware-owned sink.

The physical ZS407 and executable twin are separately selectable sources behind Atomizer's `tinysa-zs407` driver. The twin is owned by `../Atom-Firmware`, executes pinned firmware over `renode-monitor-bridge`, and explicitly does not model USB transactions. Neither source is an automatic substitute for SignalLab or for the other TinySA source kind.

The cross-repository source of truth is [trio-composition-v4.json](../contracts/trio-composition-v4.json). Any activation of a SignalLab stimulus sink requires a new coordinated trio contract version.
