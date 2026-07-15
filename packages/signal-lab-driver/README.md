# SignalLab driver

`@tinysa/signal-lab-driver` owns the SignalLab measurement-bridge process and
its Atomizer instrument adapter. It depends only on the shared instrument
contracts exported by `@tinysa/contracts` and the transport-neutral,
contract-aware runtime; it does not install or import `serialport` or any
TinySA protocol code.

The adapter exposes only SignalLab's admitted synthetic scalar spectrum and
detected-power capabilities. It preserves source and generator hashes,
simulation timing, producer-configuration epochs, bounded bridge renewal, and
explicit non-hardware claims. Electron main composes it beside—not through—the
TinySA driver.
