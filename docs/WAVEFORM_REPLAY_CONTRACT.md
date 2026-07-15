# SignalLab measurement and stimulus ownership notice

Status: ownership shim; updated for trio composition v4 on 2026-07-14.

Waveform descriptors, the 79-profile closed catalog, AWGN/Rayleigh channel behavior, high-level synthetic measurements, and stimulus intent are owned by the independent `../TinySA_SignalLab` repository. Its normative boundary is [SignalLab CONTRACTS](../../TinySA_SignalLab/CONTRACTS.md).

Atomizer does not contain SignalLab synthesis code. Its `signal-lab` driver launches SignalLab's separately built, version-1 NDJSON bridge and admits only bounded swept-spectrum and detected-power results qualified `synthetic-visual-projection`. This SignalLab→Atomizer measurement edge is active and is the factory default when no instrument preference exists. The selected profile remains source status/capability state and is never copied into measurement, detector, classifier, or export evidence. Bridge failure is terminal for that admission attempt and never falls back to a TinySA source.

The active measurement edge does not apply stimulus to executable firmware. SignalLab→Firmware remains a separate future `SignalLabStimulusIntent` edge with status `reserved-not-connected`; no current process supplies a Firmware-owned sink.

The physical ZS407 and executable twin are separately selectable sources behind Atomizer's `tinysa-zs407` driver. The twin is owned by `../TinySA_Firmware`, executes pinned firmware over `renode-monitor-bridge`, and explicitly does not model USB transactions. Neither source is an automatic substitute for SignalLab or for the other TinySA source kind.

The cross-repository source of truth is [trio-composition-v4.json](../contracts/trio-composition-v4.json). Any activation of a SignalLab stimulus sink requires a new coordinated trio contract version.
