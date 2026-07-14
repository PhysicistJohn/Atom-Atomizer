# Physical ZS407 characterization record

Status: partial receive-only and firmware-update acceptance
Observed: 2026-07-11
Host: macOS, USB CDC ACM

This record separates facts observed on the delivered unit from source-derived limits and unperformed RF qualification. It is evidence for Gate B; it is not a calibration certificate.

Firmware-update references below describe the accepted 2026-07-11 physical
transaction performed by the former embedded updater. Beginning with Atomizer
application contract 6 and device API v3, active firmware installation is
absent from this repository and owned exclusively by `../TinySA_Flasher`.

## Admitted unit

| Evidence | Observed value |
| --- | --- |
| Port | `/dev/tty.usbmodem4001` |
| USB VID:PID | `0483:5740` |
| Manufacturer | `tinysa.org` |
| USB serial | `400` |
| Product identity | `tinySA ULTRA+ ZS407` from `info` |
| Hardware line | `HW Version:V0.5.4 max2871` |
| Initial firmware | `tinySA4_v1.4-217-gc5dd31f` |
| Initial resolved source | `c5dd31fd4679c15ba92ff46a6e258c1e3516ff0c` |
| Verified OEM firmware after guarded update | `tinySA4_v1.4-224-gc979386` |
| Resolved OEM source | `c97938697b6c7485e7cab50bca9af76996b7d671` |
| Current observed firmware | `tinySA4_hw-v0.3-fft1024-g43eb0f1` |
| Current qualification | `custom-unqualified`; source unresolved, warning visible |
| OEM build time | `Dec 17 2025 - 10:50:40` |
| MCU/platform | STM32F303xC, ARMv7E-M Cortex-M4F |
| Shell commands observed | 79 on the custom build; all required Atomizer commands present |

The OEM source commit timestamp is 2025-12-17 10:50:06 +01:00, 34 seconds before its reported build time. Atomizer admits that revision through a closed revision-to-full-commit registry. A syntactically valid unknown revision is not assigned the host or OEM commit: it may be admitted only as `custom-unqualified` after the same exact ZS407 identity, required-command, framing and output-off gates, with an explicit warning.

The shipped `version` hardware line does not contain `ZS407`. The exact product
line appears in `info`. Physical identity therefore requires all of: exact USB
identifiers, `tinySA4_` firmware, a hardware line, strict ZS407 evidence across
`version` and `info`, a parseable source revision, and the complete required
command catalog. Source qualification is separate from identity evidence.

### Custom-firmware admission evidence

After the OEM update, the unit was observed running
`tinySA4_hw-v0.3-fft1024-g43eb0f1`. Atomizer verified the exact USB/model
identity, 79-command required surface, prompt/framing behavior, and output-off
terminal state, then admitted it as `custom-unqualified`. It deliberately did
not populate `firmwareSourceCommit` and disabled the pinned OEM updater for that
session. This proves protocol admission only; it is not RF, FFT-path, timing, or
metrology qualification of the custom firmware.

## Receive-only transaction evidence

During the receive-only qualification, the first command on every session was `output off`. No generator configuration, RF enable, firmware touch, calibration write, reset, DFU transition, or flash command was issued in those sessions. The separately governed update transaction is recorded below.

| Check | Result |
| --- | --- |
| Battery | 4.211–4.212 V during the two typed validation runs |
| Device ID | `0` |
| Analyzer readback | 88–108 MHz, 101 points, 600 kHz actual RBW, 0 dB actual attenuation |
| Text sweep | 101 rows; peak −43.03 dBm at 105.000 MHz; minimum −92.38 dBm |
| Raw sweep | 101 points; peak −42.78 dBm at 105.030 MHz; minimum −92.41 dBm |
| Raw/text agreement | peak level within 0.25 dB; minima within 0.04 dB in consecutive live sweeps |
| LCD capture wire payload | 480×320 RGB565, high byte first, exactly 307,200 bytes |
| Atomizer screen frame | byte-swapped once at the physical transport boundary to the declared RGB565LE host contract |
| LCD wire-evidence hash | `39174d17a08e3f6c09407bec2d2f8088a56232c5ec177056c8f3b5b37f53694a` |
| Terminal state | clean disconnect with another `output off`; RF state no longer inferred after close |

### LCD byte order resolved

The ZS407 `capture` command streams the ST7796S memory-read bytes in panel order:
the canonical RGB565 high byte followed by the low byte. This is directly
consistent with the firmware's byte-reversed `RGB565` storage macro and was
confirmed on hardware with the runtime Atomic palette: intended background
RGB `(9, 11, 12)` appeared in the capture as bytes `08 41`, canonical RGB565
`0x0841`. Reading those bytes as a little-endian word (`0x4108`) produced the
incorrect purple/yellow mirror even though the physical panel was
charcoal/mint.

The public `ScreenFrame` contract remains RGB565LE. The physical device adapter
performs the one required byte swap after consuming the exact fixed-length
payload. The executable-twin bridge already performs the same panel-order to
host-order conversion; protocol fixtures are already host-order. This keeps
rendering transport-independent without falsifying the physical wire format.

### Raw sweep variance resolved

The firmware emits each `scanraw` sample as signed Q5 dB after adding configurable `config.ext_zero_level`. This unit reports the default offset as `174dBm` through the read-only `zero` query. Treating the encoded values as absolute dBm produced impossible positive values.

Atomizer now:

1. requires the `zero` command at admission;
2. reads the current offset immediately before every raw sweep;
3. validates the fixed brace/marker/int16 payload;
4. divides by 32 and subtracts the observed offset;
5. records `rawSweepOffsetDb` with the resulting sweep.

The protocol test double and executable twin implement the same offset-bearing wire contract. Atomizer does not mutate the device offset to simplify parsing.

## OEM update evidence

The current OEM Ultra/Ultra+ directory publishes `tinySA4_v1.4-224-gc979386.bin`, which resolves to the existing host baseline `c97938697b6c7485e7cab50bca9af76996b7d671`.

| Artifact fact | Value |
| --- | --- |
| URL | `http://dfu.tinydevices.org/tinySA4/DFU/tinySA4_v1.4-224-gc979386.bin` |
| Size | 185,704 bytes |
| SHA-256 | `3c9847ff4d7b80561df2f2f1030a112703a083409ffb2ee11361b2413b7c1e41` |

Atomizer downloaded and verified this exact artifact into its private application cache. After the required local-human preflight and DFU transition, one write started at `2026-07-11T23:24:37.404Z`, completed at `2026-07-11T23:25:15.429Z`, and passed post-reboot identity at `2026-07-11T23:25:17.966Z`. The durable final state is `completed`; the returned source is the exact pinned `c97938697b6c7485e7cab50bca9af76996b7d671`. The OEM procedure, one-shot rule, and evidence semantics are captured in [FIRMWARE_UPDATE_CONTRACT.md](./FIRMWARE_UPDATE_CONTRACT.md).

## Still unqualified

- Other supported operating systems and USB permission behavior.
- All point-count/cadence combinations, long-duration streaming, and thermal behavior.
- Cable-loss behavior during each operation phase.
- Remote touch coordinates on the physical panel.
- Manual RBW/attenuation edge cases and high-frequency transitions.
- RF amplitude/frequency accuracy, DANL, phase noise, compression, harmonics, spurs, generator paths, modulation, and loads.
- Pre- and post-update self-test equivalence.
- Power-loss, cable-loss, host-crash, and recovery behavior during a future authorized update transaction.

These remain explicit release gates. Source-addressable ranges and successful shell commands are not substitutes for RF metrology.
