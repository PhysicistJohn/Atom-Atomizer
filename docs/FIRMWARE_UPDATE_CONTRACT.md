# ZS407 firmware update contract

Status: implementation baseline; physical write not yet performed
Version: 1.0.0
Updated: 2026-07-11

This contract governs Atomizer’s updater for one verified physical tinySA Ultra+ ZS407. It does not create a generic firmware browser or accept “latest” by filename, directory order, redirect, or server metadata.

## Pinned release

Atomizer accepts exactly:

```text
product       tinySA Ultra / Ultra+
version       tinySA4_v1.4-224-gc979386
source        c97938697b6c7485e7cab50bca9af76996b7d671
URL           http://dfu.tinydevices.org/tinySA4/DFU/tinySA4_v1.4-224-gc979386.bin
bytes         185704
SHA-256       3c9847ff4d7b80561df2f2f1030a112703a083409ffb2ee11361b2413b7c1e41
```

The OEM host currently serves the artifact over HTTP. Transport metadata is not trusted. The complete body must have the pinned `Content-Length`, exact byte count, and SHA-256 before it is atomically retained with user-only permissions. A cached artifact is re-read and re-hashed. Corrupt cache evidence fails visibly and is not silently replaced; a fresh download is an explicit action.

## State machine

```text
idle -> available -> downloading -> verified -> awaiting-dfu
                                             -> ready-to-flash
                                             -> flashing
                                             -> reconnecting
                                             -> completed

any pre-write state -> failed
write-started + interruption -> failed / indeterminate-completion / do-not-flash-again
write-complete + verification failure -> failed / do-not-flash-again
target already installed -> up-to-date
```

Every operation settles once. Network and DFU failures do not retry automatically. Reconnection polling after a successful write is verification of the one completed transaction, not another write attempt.

Beginning with preflight, every safety-relevant transition is atomically journaled in the private application cache and schema-validated on every process start. A corrupt or unreadable journal produces an `indeterminate` write disposition and locks flashing pending manual inspection. A restart from `ready-to-flash` requires fresh DFU discovery; a restart from `flashing` or `reconnecting` enters a do-not-flash recovery state.

## Automatic behavior

After one exact physical ZS407 is admitted, Atomizer compares the reported source revision with the pinned target. An older supported revision opens the updater and downloads/verifies the artifact. Automatic behavior stops at `verified`.

Atomizer never automatically:

- attests a self-test;
- changes calibration/configuration disposition;
- disconnects RF cabling;
- disconnects the instrument for DFU;
- enters DFU mode;
- installs host tooling;
- writes firmware;
- clears configuration;
- runs post-update calibration or self-test.

## Human preflight boundary

The OEM procedure requires a pre-update self-test. The visual workflow requires local human attestation that:

1. the pre-update self-test passed with the supplied SMA cable between LOW and HIGH;
2. that cable and every other RF connection have subsequently been removed;
3. the unit is either new/unchanged or configuration backup and recalibration consequences are accepted.

Main then refreshes exact identity, command catalog, analyzer readback, battery, and device ID; requires at least 4.000 V; captures and hashes the LCD; writes an immutable preflight JSON record; commands RF output off; and closes USB CDC. A failed check does not enter DFU guidance.

## DFU admission

The known flashing engine is exactly `dfu-util 0.11`, resolved from `TINYSA_DFU_UTIL` or deterministic executable paths. Missing or different tooling disables the write path.

The human enters Ultra/Ultra+ DFU mode by switching off, holding the jog control, and switching on with the screen remaining black. Atomizer runs `dfu-util -l`, groups every `0483:df11` interface by mandatory path/device identity, requires exactly one physical STM32 DFU device, and then admits exactly one line satisfying all of:

```text
USB identity     0483:df11
alternate        alt=0
target name      @Internal Flash
matching count   exactly one
```

Zero STM32 matches remains `awaiting-dfu`. Multiple STM32 devices, multiple/missing exact internal-flash targets on a present STM32 device, malformed identity output, or another alternate rejects the transition.

## One-shot write boundary

Immediately before writing, Atomizer re-reads the cached artifact and repeats exact size and SHA-256 verification. Only the local control marked `human-flash-boundary` can submit the literal confirmation and execute:

```text
dfu-util -d 0483:df11 -a 0 -s 0x08000000:leave -D <verified artifact>
```

Immediately before starting `dfu-util`, Atomizer atomically records `writeDisposition=started` and `writeStartedAt`, then writes an exclusive-create intent audit. If the process, host, tool, or journal fails after that point, completion is conservatively unknown and no code path may issue the write again. Exit status alone is insufficient; output must contain dfu-util’s successful-download confirmation. Atomizer then persists `writeDisposition=completed` and `writeCompletedAt` before post-write verification.

The device must reappear as exactly one `0483:5740` physical candidate within 30 seconds and pass normal identity admission as revision `c979386`. Otherwise the state explicitly says the write completed but verification failed and forbids another flash. Recovery follows the OEM Ultra/Ultra+ jog-button procedure, not an automatic retry.

Post-reboot identity proves only that the expected firmware returned over exact USB. It does not prove RF performance or configuration compatibility. Completion instructs the human to power-cycle, follow the OEM `CONFIG/MORE/CLEAR CONFIG 1234` guidance, and run the post-update self-test; Atomizer does not automate those physical/configuration actions.

## Atom boundary

Atom surface v4 can:

- read updater state and evidence;
- open the updater;
- download and verify the pinned artifact;
- observe DFU presence after human preparation;
- explain the OEM sequence and current blocker.

Atom, coordinate computer use, keyboard/type/scroll computer paths, and semantic computer actions cannot set the safety attestations, disconnect for DFU, or activate the flash control. Those elements are explicitly excluded from the agent surface, and the two transition controls also require a trusted local UI event. This is a deliberate governed hook, not missing coverage.

## Acceptance

- Unknown installed firmware revision is rejected before updater offer.
- Wrong URL response status, redirect, length, byte count, or hash cannot produce a verified artifact.
- First physical session command and every disconnect attempt command `output off`.
- Battery below 4.000 V blocks preparation.
- Preflight JSON is exclusive-create and includes identity, telemetry, commands, readback, artifact evidence, and screen hash.
- Missing/wrong `dfu-util`, zero/multiple DFU targets, or wrong alternate cannot write.
- The artifact is re-hashed immediately before the one write.
- Durable write-attempt evidence is committed before the subprocess starts and blocks repeat writes across app crashes or restarts.
- Invalid durable journal evidence fails with an indeterminate write lock rather than resetting the transaction.
- Completion requires post-reboot exact USB, ZS407 identity, and pinned source revision.
- All updater API methods have Atom coverage or an explicit machine-checked human-safety-boundary disposition.

OEM references:

- https://tinysa.org/wiki/pmwiki.php?n=Main.UpdatingTheFirmware
- https://tinysa.org/wiki/pmwiki.php?n=TinySA4.FWupdate
