# ZS407 firmware update contract

Status: historical Atomizer record; active implementation owned by `../Atom-Flasher`
Version: 1.2.0
Updated: 2026-07-17

Beginning with Atomizer application contract 6 and device API v3, TinySA contains
no firmware download, preflight, DFU detection, or flash implementation and no
Atom tool or renderer control for those operations. The standalone sibling
application `../Atom-Flasher` is their exclusive owner. References to Atomizer
below describe the accepted pre-extraction implementation and preserved physical
transaction evidence; they are not a current Atomizer capability or API contract.

This record governed the former embedded Atomizer updater for one verified
physical tinySA Ultra+ ZS407. It does not authorize a current Atomizer write
path, and it is not the active TinySA Flasher contract. The preserved design did
not create a generic firmware browser or accept “latest” by filename, directory
order, redirect, or server metadata.

## Current standalone handoff

Atomizer owns normal CDC analyzer/generator sessions and requests the native
exclusive serial lock for every admitted physical open. TinySA Flasher owns CDC
discovery/preflight, DFU admission/write, and CDC post-write verification for a
complete update session. The operator must disconnect or close Atomizer before
starting Flasher and finish or safely exit Flasher before reconnecting; there is
no current automatic cross-application lease or handoff protocol.

For owner-built firmware, Flasher's native manifest picker starts in the sibling
`../Atom-Firmware` checkout when it exists and remembers another directory
only after a selected manifest passes normal admission. The picker default is
not artifact evidence and creates no Atomizer runtime dependency.

## Historical pinned release

The former embedded Atomizer updater accepted exactly:

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
custom-unqualified installed -> custom-firmware / updater disabled
custom-source-qualified-receive-only installed -> custom-firmware / updater disabled
```

Every operation settles once. Network and DFU failures do not retry automatically. Reconnection polling after a successful write is verification of the one completed transaction, not another write attempt.

Beginning with preflight, every safety-relevant transition is atomically journaled in the private application cache and schema-validated on every process start. A corrupt or unreadable journal produces an `indeterminate` write disposition and locks flashing pending manual inspection. A restart from `ready-to-flash` requires fresh DFU discovery; a restart from `flashing` or `reconnecting` enters a do-not-flash recovery state.

## Historical automatic behavior

After one exact physical ZS407 is admitted, Atomizer compares the reported source revision with the pinned target. An older supported revision opens the updater and downloads/verifies the artifact. Automatic behavior stops at `verified`.

A valid but unregistered revision remains admitted as `custom-unqualified` for
instrument use. The exact frozen-source receiver record may instead be admitted
as `custom-source-qualified-receive-only`, but that narrow source proof is not
installation authority or artifact attestation. In both cases the historical
OEM updater enters `custom-firmware` state with an explicit warning and all
download/prepare/flash actions disabled. Atomizer does not guess whether an OEM
image is an upgrade, downgrade, or compatible replacement for owner-built
firmware.

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

## Historical human preflight boundary

The OEM procedure requires a pre-update self-test. For the admitted Ultra+ ZS407, the hardware-specific procedure is closed as `tinySA4-zs407-cal-rf-v1`:

1. confirm RF output is off;
2. connect one short 50 Ω coax cable between the SMA connectors physically labeled `CAL` and `RF`;
3. on the instrument, select `CONFIG > SELF TEST`;
4. let every test finish and touch the screen only when prompted;
5. confirm the self-test passed, exit it, and remove the CAL↔RF cable and every RF connection.

The generic Basic/older-device wording “LOW and HIGH” is explicitly invalid for this ZS407 contract. The updater renders these steps, links only to the allow-listed OEM Ultra/Ultra+ menu guide, and records the exact procedure ID. The visual workflow then requires local human attestation that:

1. the pre-update self-test passed under the exact CAL↔RF procedure;
2. that cable and every other RF connection have subsequently been removed;
3. the unit is either new/unchanged or configuration backup and recalibration consequences are accepted.

Main then refreshes exact identity, command catalog, analyzer readback, battery, and device ID; requires at least 4.000 V; captures and hashes the LCD; writes an immutable preflight JSON record; commands RF output off; and closes USB CDC. A failed check does not enter DFU guidance.

## Historical DFU admission

The known flashing engine is exactly `dfu-util 0.11`, resolved from `TINYSA_DFU_UTIL` or deterministic executable paths. Missing or different tooling disables the write path.

The human enters Ultra/Ultra+ DFU mode by switching off, holding the jog control, and switching on with the screen remaining black. Atomizer runs `dfu-util -l`, groups every `0483:df11` interface by mandatory path/device identity, requires exactly one physical STM32 DFU device, and then admits exactly one line satisfying all of:

```text
USB identity     0483:df11
alternate        alt=0
target name      @Internal Flash
matching count   exactly one
```

Zero STM32 matches remains `awaiting-dfu`. Multiple STM32 devices, multiple/missing exact internal-flash targets on a present STM32 device, malformed identity output, or another alternate rejects the transition.

## Historical one-shot write boundary

Immediately before writing, Atomizer re-reads the cached artifact and repeats exact size and SHA-256 verification. Only the local control marked `human-flash-boundary` can submit the literal confirmation and execute:

```text
dfu-util -d 0483:df11 -a 0 -s 0x08000000:leave -D <verified artifact>
```

Immediately before starting `dfu-util`, Atomizer atomically records `writeDisposition=started` and `writeStartedAt`, then writes an exclusive-create intent audit. If the process, host, tool, or journal fails after that point, completion is conservatively unknown and no code path may issue the write again. Exit status alone is insufficient; output must contain dfu-util’s successful-download confirmation. Atomizer then persists `writeDisposition=completed` and `writeCompletedAt` before post-write verification.

While that single subprocess is active, Atomizer parses dfu-util's carriage-return progress records rather than inventing a time estimate. The closed progress projection is `preparing=0%`, erase `0–40%`, download `40–95%`, reboot verification `98%`, and identity-complete `100%`; erase/download also carry the exact stage percentage reported by dfu-util. The dialog displays stage, overall percentage, elapsed time, and an uninterrupted USB/power warning. A renderer progress-channel failure is surfaced immediately and never triggers, cancels, or repeats the irreversible subprocess.

The device must reappear as exactly one `0483:5740` physical candidate within 30 seconds and pass normal identity admission as revision `c979386`. Otherwise the state explicitly says the write completed but verification failed and forbids another flash. Recovery follows the OEM Ultra/Ultra+ jog-button procedure, not an automatic retry.

Post-reboot identity proves only that the expected firmware returned over exact USB. It does not prove RF performance or configuration compatibility. Completion instructs the human to power-cycle, follow the OEM `CONFIG/MORE/CLEAR CONFIG 1234` guidance, and run the post-update self-test; Atomizer does not automate those physical/configuration actions.

## Accepted physical transaction

The delivered ZS407 completed one human-authorized transaction on 2026-07-11. Durable evidence records `writeStartedAt=2026-07-11T23:24:37.404Z`, `writeCompletedAt=2026-07-11T23:25:15.429Z`, and final completion at `2026-07-11T23:25:17.966Z`. The write therefore occupied 38.025 seconds; exact USB admission then returned the pinned `tinySA4_v1.4-224-gc979386` / `c97938697b6c7485e7cab50bca9af76996b7d671` identity. The journal is `completed`, so the one-shot guard forbids using this transaction as permission to flash again.

The build used for that transaction displayed an indeterminate wait animation during the write. This was an observability defect, not a second write or an uncertain outcome: subprocess output, timestamps, success confirmation, and post-reboot identity all completed. The final embedded implementation replaced that wait with the contracted live parser and retained recorded-output parser, state-schema, renderer, and accessibility evidence. That implementation was then removed from Atomizer; the standalone TinySA Flasher now owns all executable update behavior. The accepted transaction is intentionally not re-qualified by performing another unnecessary physical write.

## Historical Atom boundary

The retired Atom surface v4 could:

- read updater state and evidence;
- open the updater;
- download and verify the pinned artifact;
- observe DFU presence after human preparation;
- explain the OEM sequence and current blocker.

Atom, coordinate computer use, keyboard/type/scroll computer paths, and semantic computer actions cannot set the safety attestations, disconnect for DFU, or activate the flash control. Those elements are explicitly excluded from the agent surface, and the two transition controls also require a trusted local UI event. This is a deliberate governed hook, not missing coverage.

## Preserved historical acceptance evidence

- A valid unknown installed revision is warning-admitted as custom firmware, never assigned OEM provenance, and cannot enter the OEM updater transaction.
- Wrong URL response status, redirect, length, byte count, or hash cannot produce a verified artifact.
- First physical session command and every disconnect attempt command `output off`.
- Battery below 4.000 V blocks preparation.
- Preflight JSON is exclusive-create and includes identity, telemetry, commands, readback, artifact evidence, and screen hash.
- Missing/wrong `dfu-util`, zero/multiple DFU targets, or wrong alternate cannot write.
- The artifact is re-hashed immediately before the one write.
- Durable write-attempt evidence is committed before the subprocess starts and blocks repeat writes across app crashes or restarts.
- Invalid durable journal evidence fails with an indeterminate write lock rather than resetting the transaction.
- Completion requires post-reboot exact USB, ZS407 identity, and pinned source revision.
- Live progress is derived only from dfu-util stage records; impossible stage/phase/percentage combinations fail schema validation.
- A progress-channel failure is visible and cannot cause a write retry.
- All updater API methods have Atom coverage or an explicit machine-checked human-safety-boundary disposition.

OEM references:

- https://tinysa.org/wiki/pmwiki.php?n=Main.UpdatingTheFirmware
- https://tinysa.org/wiki/pmwiki.php?n=TinySA4.FWupdate
- https://tinysa.org/wiki/pmwiki.php?n=TinySA4.MenuTree
