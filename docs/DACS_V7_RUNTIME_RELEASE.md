# DACS v7 runtime release

Status: production runtime integration

Updated: 2026-08-02

## Claim boundary

Atomizer uses DACS v7 only as a closed-set family refinement after the released
time-domain v3 open-set gate accepts a capture. It does not bypass a v3
abstention. The runtime admits only contiguous complex I/Q at exactly 20 Msps,
does not resample, and selects the largest trained prefix present: 20,000,
50,000, or 200,000 samples (1 ms, 2.5 ms, or 10 ms).

The seven output families are `am`, `bluetooth`, `cw`, `dsss`, `fm`, `gsm`, and
`ofdm`. They are modulation families, not decoded protocols or emitter
identities. The exported confidence head remains diagnostic and has no
open-set, dwell-selection, or decision authority.

## Sealed release

The runtime package was exported from clean Atom-Classifier commit
`ab4995200470630133637f36a05d069400c27f9f`. Its checkpoint was trained from
clean Atom-Classifier and Atom-SignalLab source revisions
`2014019a68f56ad83ec24277970252b9405ff030` and
`12e7eefec06047308eb7053ec33abe54f94d6160`, respectively.

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| Package manifest | 6,425 | `19aaa1b93c8a22a613e18cfee728718a998aec633fc085456fca9c96684f7d1f` |
| ONNX encoder | 4,137,944 | `c51177a2375113500c1446693c42edee52ce8eaef2d15a044076c7f061def933` |
| Fixed prototypes | 79,118 | `1dd9e4252ac2d11d3906e665808dfee370a2db4c0f00806d7a8d1fb5c1325dcd` |
| Validation evidence | 37,286 | `415d605bd822f14a37d1d90a30bd2e7a65755efae3fd432847f9eec517236cc7` |
| ONNX Runtime 1.27 SIMD WASM | 13,479,978 | `d1ab1b94b16a65b29d710d0b587b29e7bed336827577623913479b8afe8113e6` |

The model contains 1,031,585 initializer values and 93 ONNX nodes. The browser
loads the package with bounded streaming, verifies every byte count and SHA-256
before session creation, and fails closed on any mismatch. The validation JSON
is shipped as release evidence but is not fetched during inference.

## Release quality

The fixed-prototype release evaluation uses 3,264 query rows for each of five
independent random-offset plans. Values below are the mean over those plans;
the range is the minimum and maximum plan result.

| Dwell | Balanced accuracy | Plan range | Mean minimum-profile recall | Mean errors / 3,264 |
|---|---:|---:|---:|---:|
| 1 ms | 90.04% | 89.18-90.75% | 23.13% | 508.4 |
| 2.5 ms | 95.07% | 94.69-95.57% | 58.75% | 245.0 |
| 10 ms | 99.39% | 99.15-99.56% | 96.46% | 14.8 |

The short-dwell weakness is concentrated in GSM profile recall and is why the
runtime always chooses the largest available trained dwell. These are
synthetic held-out corpus results; they are not calibrated field accuracy.

## Runtime and deployment checks

The TypeScript preprocessing reproduces the Torch RMS-normalize plus periodic
Hann-64/hop-32 complex FFT reference. ONNX/WASM tests compare the Torch
end-to-end result at all three dynamic frame lengths. The worker transfers the
I/Q buffers, preserves the v3 rejection boundary, and reports the selected
dwell and execution provider in the Detect UI.

A local Apple M5 Max / Node 24.18.1 acceptance run measured a 161.2 ms cold
package-load, hash-verification, session-create, and 1 ms inference path. With
the session warm, median end-to-end WASM times were 30.5 ms, 76.3 ms, and
302.0 ms for 1 ms, 2.5 ms, and 10 ms inputs. Median preprocessing alone was
0.54 ms, 1.51 ms, and 5.35 ms. These are local runtime measurements, not a
cross-device performance guarantee.

Browser and packaged-desktop builds use the same model, prototype, and
validation bytes. ONNX Runtime Web 1.27.0 (MIT) is exact-version pinned as a
build dependency. Each target emits its 24,180-byte same-origin module bootstrap
and one 13.48 MB SIMD-WASM binary; the packaged `file:` renderer reads that
binary through the allow-listed classifier protocol. No alternate ORT backend
binary is packaged.

The final arm64 package contained a 51 MB `app.asar`, a 134 MB DMG, and a 133 MB
ZIP. Removing ORT's unused backend variants reduced the intermediate `app.asar`
from 186 MB and the DMG from 164 MB. `codesign --verify --deep --strict` passed;
the local package is ad-hoc signed and intentionally not notarized.

Production-build UI smokes exercised both the browser and packaged desktop
paths with SignalLab AM at 20 Msps and 50,000 samples. Both returned AM at 100%
and exposed `DACS V7 · 2.5MS · V3 OPEN-SET · WASM` in Detect. Every individual
deployed asset remains below the Workers static-asset per-file limit.
