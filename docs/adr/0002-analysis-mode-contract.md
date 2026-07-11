# ADR 0002: Extensible analysis modes

Status: accepted for foundation

## Decision

Analysis consumes immutable, self-describing `Sweep` records and emits versioned domain results. It never owns the serial port and cannot issue raw device commands. Mode definitions declare required capabilities and readiness status. New analysis modes extend this boundary rather than Electron IPC.

The first modes are:

1. **Signal Detection** — estimates an absolute or adaptive threshold, segments contiguous occupied bins, and produces detections carrying frequency, bandwidth, peak, time, and source sweep provenance.
2. **Waveform Classification** — consumes detections plus capture evidence and returns ranked candidates, calibrated confidence, model identity, and an explicit `unknown` class.

## Classification quality bar

A classifier is not considered available merely because inference executes. Its contract must later include:

- A versioned, labeled, split-by-capture-source corpus to prevent train/test leakage.
- A declared waveform taxonomy and an open-set/unknown evaluation set.
- Model and preprocessing hashes, training provenance, and deterministic inference fixtures.
- Per-class precision, recall, F1, confusion matrix, calibration error, and false-positive rate.
- Acceptance thresholds agreed after representative ZS407 captures exist.
- Local inference with bounded CPU/memory and no network requirement.
- UI evidence explaining center frequency, bandwidth, temporal context, and confidence—not a bare label.

Until those conditions are met, the supplied `UnknownClassifier` returns `unknown` with zero confidence. This prevents simulated or heuristic behavior from masquerading as RF classification.

## Extension interface

An analysis package must be pure domain code or a worker-hosted compute adapter. It declares metadata, validates configuration, consumes contract types, produces serializable results, supports cancellation for long work, and supplies deterministic fixtures. Renderer components visualize results but do not contain detection/classification algorithms.
