# ADR 0001: Process and transport boundaries

Status: accepted for foundation

## Decision

The tinySA is accessed as USB CDC serial through Node SerialPort in Electron's main process. The renderer remains sandboxed with context isolation and receives only named, runtime-validated operations through preload. `packages/tinysa` has no Electron or React dependency and operates against a `ByteTransport`, allowing identical protocol logic on real serial and fake byte streams.

Exactly one scheduler owns response parsing. Streaming is a scheduler mode, not a second reader. A response is either proven complete by its response contract or the connection is treated as unsynchronized.

## Consequences

Native serial bindings must be rebuilt and tested for packaged Electron. The architecture gains deterministic simulation, bounded concurrency, and a narrow security boundary. Web Serial is not part of v1.
