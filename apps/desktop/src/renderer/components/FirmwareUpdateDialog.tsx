import { AlertTriangle, Check, Download, LoaderCircle, ShieldCheck, Terminal, Usb, X, Zap } from 'lucide-react';
import type { FirmwareUpdatePreflight, FirmwareUpdateState } from '@tinysa/contracts';

export function FirmwareUpdateDialog({ state, busy, preflight, onPreflight, onDownload, onPrepare, onDetect, onFlash, onClose }: {
  state: FirmwareUpdateState;
  busy: boolean;
  preflight: Partial<FirmwareUpdatePreflight>;
  onPreflight(value: Partial<FirmwareUpdatePreflight>): void;
  onDownload(): void;
  onPrepare(event: React.MouseEvent<HTMLButtonElement>): void;
  onDetect(): void;
  onFlash(event: React.MouseEvent<HTMLButtonElement>): void;
  onClose(): void;
}) {
  const locked = busy || state.phase === 'flashing' || state.phase === 'reconnecting';
  const artifactVerified = Boolean(state.artifact);
  const preflightComplete = preflight.selfTestPassed === true && preflight.rfPortsDisconnected === true && Boolean(preflight.configurationDisposition);
  return <div className="dialog-backdrop firmware-backdrop" role="presentation">
    <section className="firmware-dialog" role="dialog" aria-modal="true" aria-labelledby="firmware-title">
      <header className="firmware-head">
        <div><span className="firmware-icon"><ShieldCheck size={20}/></span><span><small>VERIFIED OEM RELEASE</small><h2 id="firmware-title">Firmware update</h2></span></div>
        <button data-agent-control="firmware.close" className="icon-button" disabled={locked} onClick={onClose} aria-label="Close firmware update"><X size={17}/></button>
      </header>

      <div className="firmware-route" aria-label="Firmware update progress">
        <Step label="Verify" active={['available','downloading'].includes(state.phase)} complete={artifactVerified}/>
        <Step label="Preflight" active={state.phase === 'verified'} complete={Boolean(state.preparation)}/>
        <Step label="DFU" active={state.phase === 'awaiting-dfu'} complete={state.dfuDevice.detected}/>
        <Step label="Flash" active={['ready-to-flash','flashing','reconnecting'].includes(state.phase)} complete={state.phase === 'completed'}/>
      </div>

      <div className="firmware-release-card">
        <div><small>INSTALLED</small><strong>{state.current?.version ?? 'Captured in preflight'}</strong></div>
        <span>→</span>
        <div><small>TARGET</small><strong>{state.target.version}</strong></div>
      </div>

      <div className="firmware-stage">
        {(state.phase === 'available' || state.phase === 'downloading') && <Stage icon={state.phase === 'downloading' ? <LoaderCircle className="spin"/> : <Download/>} title={state.phase === 'downloading' ? 'Downloading the pinned image' : 'Update available'}>
          <p>Atomizer accepts only this exact Ultra/Ultra+ binary. The OEM host is HTTP, so authenticity is established by the pinned SHA-256 before the file is retained.</p>
          <FirmwareFacts state={state}/>
          <button data-agent-control="firmware.download" className="primary firmware-primary" disabled={busy} onClick={onDownload}>{busy ? <LoaderCircle className="spin" size={14}/> : <Download size={14}/>}Download and verify</button>
        </Stage>}

        {state.phase === 'verified' && <Stage icon={<ShieldCheck/>} title="Physical preflight">
          <p>The OEM requires a self-test before updating. Run it with the supplied SMA cable between LOW and HIGH, then remove that cable and every RF connection before continuing.</p>
          <div className="firmware-checks">
            <SafetyCheck checked={preflight.selfTestPassed === true} onChange={(checked) => onPreflight({ ...preflight, selfTestPassed: checked || undefined })} label="Pre-update self-test passed"/>
            <SafetyCheck checked={preflight.rfPortsDisconnected === true} onChange={(checked) => onPreflight({ ...preflight, rfPortsDisconnected: checked || undefined })} label="Both RF ports are disconnected"/>
            <label data-agent-exclusion="human-safety-attestation"><span>Configuration disposition</span><select value={preflight.configurationDisposition ?? ''} onChange={(event) => onPreflight({ ...preflight, configurationDisposition: event.target.value as FirmwareUpdatePreflight['configurationDisposition'] || undefined })}><option value="">Choose…</option><option value="new-device-unchanged">New device · no calibration changes</option><option value="backup-complete-and-recalibration-accepted">Backup complete · recalibration accepted</option></select></label>
          </div>
          <div className="firmware-proof"><Check size={13}/><span>Image verified</span><code>{state.artifact?.sha256}</code></div>
          <button data-agent-control="firmware.prepare" data-agent-risk="high-impact" data-agent-exclusion="human-firmware-preflight" className="primary firmware-primary" disabled={busy || !preflightComplete} onClick={onPrepare}><Usb size={14}/>Record preflight and disconnect</button>
        </Stage>}

        {state.phase === 'awaiting-dfu' && <Stage icon={<Usb/>} title="Enter STM32 DFU mode">
          <ol><li>Switch the tinySA Ultra+ off.</li><li>Press and hold the jog button.</li><li>Switch it on; the screen must stay black.</li><li>Keep only USB connected. Atomizer will look for one exact <code>0483:df11</code> target.</li></ol>
          {state.dfuUtility.available
            ? <div className="firmware-prerequisite good"><Check size={14}/><span><strong>dfu-util {state.dfuUtility.version}</strong><small>Known flashing engine ready</small></span></div>
            : <div className="firmware-prerequisite"><Terminal size={15}/><span><strong>dfu-util 0.11 required</strong><small>Install once in Terminal: <code>brew install dfu-util</code></small></span></div>}
          <button data-agent-control="firmware.detect-dfu" className="secondary firmware-primary" disabled={busy || !state.dfuUtility.available} onClick={onDetect}>{busy ? <LoaderCircle className="spin" size={14}/> : <Usb size={14}/>}Check DFU target</button>
        </Stage>}

        {state.phase === 'ready-to-flash' && <Stage icon={<Zap/>} title="One verified DFU target is ready">
          <p>The app found exactly one STM32 internal-flash interface. The image will be re-hashed immediately before write. This is the only control that writes firmware.</p>
          <div className="flash-boundary"><AlertTriangle size={16}/><span><strong>Final physical boundary</strong><small>Do not unplug USB or remove power until Atomizer reports post-flash identity verification.</small></span></div>
          <button data-agent-control="firmware.flash" data-agent-risk="high-impact" data-agent-exclusion="human-flash-boundary" className="danger-fill firmware-primary" disabled={busy} onClick={onFlash}><Zap size={14}/>Flash verified OEM firmware</button>
        </Stage>}

        {(state.phase === 'flashing' || state.phase === 'reconnecting') && <Stage icon={<LoaderCircle className="spin"/>} title={state.phase === 'flashing' ? 'Writing firmware—do not disconnect' : 'Write complete—verifying reboot'}>
          <p>{state.phase === 'flashing' ? 'dfu-util is writing the exact pinned image to 0x08000000. The application is locked at this boundary.' : 'The write completed once. Atomizer will not repeat it; it is waiting for the serial device to return and prove the target firmware identity.'}</p>
          <div className="firmware-wait"><i/><i/><i/></div>
        </Stage>}

        {state.phase === 'completed' && <Stage icon={<Check/>} title="Firmware verified after reboot">
          <p>The physical ZS407 returned over exact USB and identified as <code>{state.target.version}</code>. Power-cycle it, follow the OEM CLEAR CONFIG guidance, then run the post-update self-test before RF work.</p>
          <div className="firmware-complete"><Check size={17}/><span><strong>Update complete</strong><small>{state.completedAt}</small></span></div>
          <button data-agent-control="firmware.done" className="primary firmware-primary" onClick={onClose}>Return to Atomizer</button>
        </Stage>}

        {state.phase === 'up-to-date' && <Stage icon={<Check/>} title="Firmware is current"><p>The connected physical ZS407 already matches Atomizer’s pinned OEM release.</p><button data-agent-control="firmware.done" className="primary firmware-primary" onClick={onClose}>Done</button></Stage>}

        {state.phase === 'failed' && <Stage icon={<AlertTriangle/>} title={state.writeDisposition !== 'not-started' ? 'Firmware write state needs attention' : 'Update stopped safely'} danger>
          <p>{state.error}</p>
          {state.writeDisposition !== 'not-started'
            ? <div className="flash-boundary"><AlertTriangle size={16}/><span><strong>Do not flash again</strong><small>{state.writeDisposition === 'completed' ? 'The write completed. Recover only by verifying reboot and USB identity.' : 'A write may have begun or its durable journal is indeterminate. Inspect and recover; never repeat the write.'}</small></span></div>
            : state.preparation
              ? <button data-agent-control="firmware.detect-dfu" className="secondary firmware-primary" disabled={busy || !state.dfuUtility.available} onClick={onDetect}><Usb size={14}/>Re-check DFU state</button>
              : <button data-agent-control="firmware.download" className="secondary firmware-primary" disabled={busy} onClick={onDownload}><Download size={14}/>Download a fresh verified copy</button>}
        </Stage>}
      </div>

      <footer className="firmware-foot"><span>OEM SOURCE · tinydevices.org/tinySA4/DFU</span><span>FAIL-CLOSED · NO AUTOMATIC FLASH</span></footer>
    </section>
  </div>;
}

function Step({ label, active, complete }: { label: string; active: boolean; complete: boolean }) { return <div className={`${active ? 'active' : ''} ${complete ? 'complete' : ''}`}><i>{complete ? <Check size={10}/> : null}</i><span>{label}</span></div>; }
function Stage({ icon, title, children, danger = false }: { icon: React.ReactNode; title: string; children: React.ReactNode; danger?: boolean }) { return <div className={`firmware-stage-content ${danger ? 'danger' : ''}`}><div className="firmware-stage-title"><span>{icon}</span><h3>{title}</h3></div>{children}</div>; }
function SafetyCheck({ checked, onChange, label }: { checked: boolean; onChange(value: boolean): void; label: string }) { return <label className="firmware-check" data-agent-exclusion="human-safety-attestation"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)}/><i>{checked ? <Check size={11}/> : null}</i><span>{label}</span></label>; }
function FirmwareFacts({ state }: { state: FirmwareUpdateState }) { return <div className="firmware-facts"><span><small>SIZE</small><strong>{state.target.sizeBytes.toLocaleString()} bytes</strong></span><span><small>REVISION</small><strong>{state.target.revision}</strong></span><span><small>SHA-256</small><strong>{state.target.sha256.slice(0, 12)}…</strong></span></div>; }
