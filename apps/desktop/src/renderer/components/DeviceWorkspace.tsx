import { useEffect, useRef } from 'react';
import { AlertTriangle, CheckCircle2, Cpu, Fingerprint, FlaskConical, MonitorUp, RefreshCw, TerminalSquare, Usb } from 'lucide-react';
import type { InstrumentScreenFrame, InstrumentSessionSnapshot } from '@tinysa/contracts';
import { SelectParameter } from './ParameterRow.js';

export interface InstrumentScreenPoint { x: number; y: number }

export function DeviceWorkspace({ session, diagnostics, frame, busy, touchBusy, selectedProfile, onProfile, onRefresh, onCapture, onTap }: {
  session?: InstrumentSessionSnapshot;
  diagnostics: readonly string[];
  frame?: InstrumentScreenFrame;
  busy: boolean;
  touchBusy: boolean;
  selectedProfile?: string;
  onProfile(profileId: string): void;
  onRefresh(): void;
  onCapture(): void;
  onTap(point: InstrumentScreenPoint): void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!frame || !canvas.current) return;
    drawFrame(canvas.current, frame);
  }, [frame]);

  const screen = session?.capabilities.features.find((feature) => feature.kind === 'screen');
  const touch = session?.capabilities.features.find((feature) => feature.kind === 'touch');
  const profile = session?.capabilities.features.find((feature) => feature.kind === 'signal-lab-profile-selection');
  const diagnosticCapability = session?.capabilities.features.find((feature) => feature.kind === 'diagnostics');
  const point = (event: React.PointerEvent<HTMLCanvasElement>): InstrumentScreenPoint => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const width = touch?.width ?? screen?.width ?? 1;
    const height = touch?.height ?? screen?.height ?? 1;
    return {
      x: Math.max(0, Math.min(width - 1, Math.floor((event.clientX - bounds.left) / bounds.width * width))),
      y: Math.max(0, Math.min(height - 1, Math.floor((event.clientY - bounds.top) / bounds.height * height))),
    };
  };

  const identity = identityPresentation(session);
  return <div className="device-layout">
    <section className="device-overview">
      <div className="panel-header"><div>{session?.provenance.sourceKind === 'signal-lab' ? <FlaskConical size={14}/> : <Cpu size={14}/>}Instrument source</div><span>{identity.qualification}</span></div>
      <div className="identity-hero"><div className="identity-chip"><span/><span/><span/><Cpu size={34}/></div><div><h2>{identity.title}</h2><p>{identity.subtitle}</p></div></div>
      {session?.provenance.sourceKind === 'serial-port'
        && (session.provenance.device.firmwareQualification === 'custom-unqualified'
          || session.provenance.device.firmwareQualification === 'custom-source-qualified-receive-only')
        && <div className="custom-firmware-warning" role="status"><AlertTriangle size={15}/><span><strong>{session.provenance.device.firmwareQualification === 'custom-source-qualified-receive-only' ? 'Custom firmware · source-qualified receive only' : 'Custom firmware · source unqualified'}</strong><small>{session.provenance.device.firmwareWarning}</small></span></div>}
      <div className="device-facts">{identity.facts.map((fact) => <Fact key={fact.label} icon={fact.icon} label={fact.label} value={fact.value} detail={fact.detail}/>)}</div>
      {profile && <div className="parameter-stack" data-agent-exclusion="human-signal-profile-boundary"><SelectParameter label="SignalLab profile" value={selectedProfile ?? profile.selectedProfileId} options={profile.profiles.map(({ profileId, centerFrequencyHz }) => ({ value: profileId, label: `${profileId} · ${(centerFrequencyHz / 1e6).toFixed(3)} MHz` }))} disabled={busy} onValue={(value) => onProfile(String(value))}/></div>}
      <div className="device-actions"><button data-agent-control="device.refresh-diagnostics" className="secondary" disabled={!diagnosticCapability || busy} onClick={onRefresh}><RefreshCw size={14}/>Refresh diagnostics</button></div>
      {diagnostics.length > 0 && <pre className="diagnostic-lines" aria-label="Instrument diagnostics">{diagnostics.join('\n')}</pre>}
    </section>

    <section className="remote-screen-panel">
      <div className="panel-header"><div><MonitorUp size={14}/>Screen</div><span>{frame ? new Date(frame.capturedAt).toLocaleTimeString() : screen ? `${screen.width} × ${screen.height} · ${screen.pixelFormat.toUpperCase()}` : 'UNAVAILABLE'}</span></div>
      <div className="screen-shell">
        {screen && <canvas
          ref={canvas}
          data-agent-control="device.remote-touch"
          data-agent-risk="high-impact"
          width={screen.width}
          height={screen.height}
          aria-label="Connected instrument screen mirror"
          aria-disabled={!touch || touchBusy}
          onPointerUp={(event) => { if (touch && !touchBusy) onTap(point(event)); }}
        />}
        {!frame && <div className="screen-empty"><MonitorUp size={26}/><strong>{screen ? 'No capture' : 'Screen capability unavailable'}</strong></div>}
      </div>
      <div className="screen-actions"><button data-agent-control="device.capture-screen" className="primary" disabled={!screen || busy} onClick={onCapture}><MonitorUp size={14}/>Capture</button><p>{touch ? 'Atom-driven taps require approval.' : 'This source exposes no touch capability.'}</p></div>
    </section>

    <section className="capability-ledger"><div className="panel-header"><div><CheckCircle2 size={14}/>Capabilities</div><span>DRIVER DECLARED</span></div><div className="ledger-grid">
      <Ledger label="Acquisition" value={session?.capabilities.acquisitions.map((capability) => capability.kind).join(' · ') || '—'}/>
      <Ledger label="Features" value={session?.capabilities.features.map((feature) => feature.kind).join(' · ') || 'None'}/>
      <Ledger label="Source" value={session?.provenance.sourceKind ?? '—'}/>
      <Ledger label="Qualification" value={session?.provenance.qualification.replaceAll('-', ' ') ?? '—'}/>
    </div></section>
  </div>;
}

interface IdentityFact { icon: React.ReactNode; label: string; value: string; detail?: string }
function identityPresentation(session: InstrumentSessionSnapshot | undefined): { title: string; subtitle: string; qualification: string; facts: readonly IdentityFact[] } {
  if (!session) return { title: 'Not connected', subtitle: 'Choose an instrument source', qualification: 'UNAVAILABLE', facts: [] };
  const provenance = session.provenance;
  if (provenance.sourceKind === 'signal-lab') return {
    title: session.candidate.displayName,
    subtitle: 'Synthetic scalar measurement source; no device identity is asserted',
    qualification: 'SYNTHETIC',
    facts: [
      { icon: <Fingerprint/>, label: 'Contract', value: `${provenance.contractId} v${provenance.contractVersion}`, detail: provenance.contractSha256.slice(0, 16) },
      { icon: <FlaskConical/>, label: 'Catalog', value: provenance.catalogSha256.slice(0, 16), detail: `Generator ${provenance.generatorSha256.slice(0, 16)}` },
      { icon: <Usb/>, label: 'USB identity', value: 'Not claimed', detail: 'usbEmulated=false' },
      { icon: <TerminalSquare/>, label: 'Firmware / RF', value: 'Not claimed', detail: 'firmwareExecuted=false · rfEmitted=false' },
    ],
  };
  if (provenance.sourceKind === 'tinysa-firmware-twin') return {
    title: provenance.device.model,
    subtitle: `${provenance.device.hardwareVersion} · ${provenance.device.firmwareVersion}`,
    qualification: 'EXECUTABLE TWIN',
    facts: [
      { icon: <Fingerprint/>, label: 'Firmware repository', value: provenance.repositoryCommit.slice(0, 12), detail: provenance.firmwareBinarySha256.slice(0, 16) },
      { icon: <TerminalSquare/>, label: 'Bridge', value: provenance.bridge },
      { icon: <Usb/>, label: 'USB transactions', value: 'Not modeled' },
    ],
  };
  const port = provenance.serialPort;
  return {
    title: provenance.device.model,
    subtitle: `${provenance.device.hardwareVersion} · ${provenance.device.firmwareVersion}`,
    qualification: provenance.device.usbIdentityVerified ? 'USB VERIFIED' : 'USB UNVERIFIED',
    facts: [
      { icon: <Usb/>, label: 'USB identity', value: port.vendorId && port.productId ? `${port.vendorId}:${port.productId}` : 'Unverified', detail: port.product ?? port.path },
      { icon: <Fingerprint/>, label: 'Firmware source', value: provenance.device.firmwareSourceCommit?.slice(0, 12) ?? (provenance.device.firmwareReportedRevision ? `unresolved · ${provenance.device.firmwareReportedRevision}` : 'Unresolved') },
      { icon: <TerminalSquare/>, label: 'Transport', value: provenance.transport },
    ],
  };
}

function Fact({ icon, label, value, detail }: IdentityFact) { return <div className="device-fact"><span>{icon}</span><div><small>{label}</small><strong>{value}</strong>{detail && <em>{detail}</em>}</div></div>; }
function Ledger({ label, value }: { label: string; value: string }) { return <div><small>{label}</small><strong>{value}</strong></div>; }

function drawFrame(canvas: HTMLCanvasElement, frame: InstrumentScreenFrame): void {
  if (canvas.width !== frame.width || canvas.height !== frame.height) throw new Error('Screen frame dimensions do not match the declared screen capability');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context is unavailable');
  const image = context.createImageData(frame.width, frame.height);
  if (frame.pixelFormat === 'rgba8888') image.data.set(frame.pixels);
  else for (let pixel = 0; pixel < frame.width * frame.height; pixel++) {
    const encoded = frame.pixels[pixel * 2]! | (frame.pixels[pixel * 2 + 1]! << 8);
    const target = pixel * 4;
    image.data[target] = Math.round(((encoded >> 11) & 0x1f) * 255 / 31);
    image.data[target + 1] = Math.round(((encoded >> 5) & 0x3f) * 255 / 63);
    image.data[target + 2] = Math.round((encoded & 0x1f) * 255 / 31);
    image.data[target + 3] = 255;
  }
  context.putImageData(image, 0, 0);
}
