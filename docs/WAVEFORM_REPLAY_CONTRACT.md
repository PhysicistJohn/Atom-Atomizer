# SignalLab ownership notice

Status: relocated on 2026-07-11.

Waveform descriptors, the 79-profile closed catalog, AWGN/Rayleigh channel behavior, and stimulus intent are owned by the independent `../TinySA_SignalLab` repository. Its normative boundary is [SignalLab CONTRACTS](../../TinySA_SignalLab/CONTRACTS.md).

TinySA Atomizer no longer contains, launches, or controls a SignalLab companion. It must report the current SignalLab→Firmware edge as `reserved-not-connected`.

The only current runtime substitute for absent physical hardware is the executable twin owned by `../TinySA_Firmware`. That twin executes pinned firmware over `renode-monitor-bridge` and explicitly does not model USB transactions.

The cross-repository source of truth is [trio-composition-v3.json](../contracts/trio-composition-v3.json). Any activation of a SignalLab stimulus sink requires a new coordinated trio contract version.
