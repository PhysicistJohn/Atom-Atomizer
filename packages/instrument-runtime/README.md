# Instrument runtime

`@tinysa/instrument-runtime` is Atomizer's transport-neutral, contract-aware
lifecycle boundary. It owns driver validation, static registration, discovery
revisions, one-session serialization, configuration and measurement admission,
event reconciliation, RF-safe teardown, and measurement fingerprints. It has
no Electron, serial, TinySA adapter, SignalLab adapter, or UI dependency. It
still enforces the closed source/provenance and feature variants defined by
`@tinysa/contracts`; adding a new source is therefore an explicit contract
evolution, not dynamic plug-in loading.

## Adding a driver

1. Define truthful candidate and session-provenance variants in
   `@tinysa/contracts`. Contract v1 deliberately keeps this union closed; a new
   source must never borrow another source's evidence.
2. Put the adapter in its own package depending on `@tinysa/contracts` and
   `@tinysa/instrument-runtime`. Do not add it to the TinySA serial package.
3. Implement `InstrumentDriver` and `InstrumentSession`, including bounded
   discovery, an idempotent pending-connection cleanup lease, capability-exact
   configuration, admitted measurements, subscription cleanup, and confirmed
   RF-off teardown wherever RF output is possible.
4. Register the driver only in Electron main. The runtime performs no dynamic
   loading and imports no adapter package.
5. Add hostile contract tests: stale/mutated candidates, oversized output,
   failed connect plus failed-then-successful cleanup, event/return mismatch,
   uncertain RF state, and disconnect retry.
6. Add source-agnostic renderer/export consumers and update the versioned
   composition contract before claiming application support.

NeptuneSDR can reuse the existing bounded complete-buffer complex-I/Q shape for
small captures. Continuous I/Q needs a separately versioned streaming contract
with ordering, backpressure, cancellation, and retention limits.
