import { useEffect, useRef } from 'react';
import { CheckCircle2, Cpu, Fingerprint, MonitorUp, RefreshCw, TerminalSquare } from 'lucide-react';
import type { CanonicalInstrumentSurface, InstrumentFeatureCapability, InstrumentScreenFrame, InstrumentSessionSnapshot } from '@tinysa/contracts';

export interface InstrumentScreenPoint { x: number; y: number }

export function DeviceWorkspace({ session, canonicalSurface, diagnostics, frame, busy, touchBusy, onRefresh, onCapture, onTap }: {
  session?: InstrumentSessionSnapshot;
  canonicalSurface?: CanonicalInstrumentSurface;
  diagnostics: readonly string[];
  frame?: InstrumentScreenFrame;
  busy: boolean;
  touchBusy: boolean;
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

  const identity = identityPresentation(session, canonicalSurface);
  return <div className="device-layout">
    <section className="device-overview">
      <div className="panel-header"><div><Cpu size={14}/>Connected instrument</div><span>{identity.qualification}</span></div>
      <div className="identity-hero"><div className="identity-chip"><span/><span/><span/><Cpu size={34}/></div><div><h2>{identity.title}</h2><p>{identity.subtitle}</p></div></div>
      <div className="device-facts">{identity.facts.map((fact) => <Fact key={fact.label} icon={fact.icon} label={fact.label} value={fact.value} detail={fact.detail}/>)}</div>
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
      <Ledger label="Acquisition" value={session?.capabilities.acquisitions.map(acquisitionLabel).join(' · ') || '—'}/>
      <Ledger label="Features" value={session?.capabilities.features.map(featureLabel).join(' · ') || 'None'}/>
      <Ledger label="Execution" value={session ? executionLabel(session.provenance.execution) : '—'}/>
      <Ledger label="Qualification" value={session?.provenance.qualification.replaceAll('-', ' ') ?? '—'}/>
    </div></section>
  </div>;
}

interface IdentityFact { icon: React.ReactNode; label: string; value: string; detail?: string }
function identityPresentation(session: InstrumentSessionSnapshot | undefined, canonicalSurface: CanonicalInstrumentSurface | undefined): { title: string; subtitle: string; qualification: string; facts: readonly IdentityFact[] } {
  if (!session) return { title: 'Not connected', subtitle: 'Choose an instrument source', qualification: 'UNAVAILABLE', facts: [] };
  if (canonicalSurface) {
    const presentation = canonicalSurface.presentation;
    return {
      title: presentation.title,
      subtitle: presentation.subtitle ?? 'Connected instrument interface',
      qualification: presentation.qualification,
      facts: presentation.facts.map((fact, index) => ({ ...fact, icon: canonicalFactIcon(index) })),
    };
  }
  const provenance = session.provenance;
  return {
    title: session.candidate.displayName,
    subtitle: `${executionLabel(provenance.execution)} · ${formatProvenanceLabel(provenance.transport)}`,
    qualification: formatProvenanceLabel(provenance.qualification).toUpperCase(),
    facts: [
      { icon: <Fingerprint/>, label: 'Session', value: session.sessionId, detail: `Verified ${new Date(provenance.verifiedAt).toLocaleString()}` },
      { icon: <TerminalSquare/>, label: 'Execution', value: executionLabel(provenance.execution) },
      { icon: <TerminalSquare/>, label: 'Transport', value: formatProvenanceLabel(provenance.transport) },
      { icon: <CheckCircle2/>, label: 'Qualification', value: formatProvenanceLabel(provenance.qualification) },
    ],
  };
}

function canonicalFactIcon(index: number): React.ReactNode {
  switch (index % 3) {
    case 0: return <Fingerprint/>;
    case 1: return <TerminalSquare/>;
    default: return <CheckCircle2/>;
  }
}

function acquisitionLabel(capability: InstrumentSessionSnapshot['capabilities']['acquisitions'][number]): string {
  switch (capability.kind) {
    case 'swept-spectrum': return 'Spectrum capture';
    case 'detected-power-timeseries': return 'Power sampling';
    case 'complex-iq': return 'Complex I/Q capture';
  }
  return 'Driver acquisition';
}

function featureLabel(feature: InstrumentFeatureCapability): string {
  switch (feature.kind) {
    case 'rf-generator': return 'RF generation';
    case 'screen': return 'Screen capture';
    case 'touch': return 'Remote touch';
    case 'diagnostics': return 'Diagnostics';
  }
  return 'Driver function';
}

function executionLabel(execution: InstrumentSessionSnapshot['provenance']['execution']): string {
  return execution === 'physical' ? 'Physical instrument' : 'Virtual instrument';
}

function formatProvenanceLabel(value: string): string {
  return value.replaceAll('-', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
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
