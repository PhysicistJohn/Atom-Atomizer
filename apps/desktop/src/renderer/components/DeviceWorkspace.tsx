import { useEffect, useRef } from 'react';
import { BatteryCharging, CheckCircle2, Cpu, Fingerprint, MonitorUp, RefreshCw, TerminalSquare, Usb } from 'lucide-react';
import type { DeviceDiagnostics, DeviceSnapshot, ScreenFrame, ScreenPoint } from '@tinysa/contracts';

export function DeviceWorkspace({ snapshot, diagnostics, frame, busy, onRefresh, onCapture, onTouch, onRelease }: {
  snapshot: DeviceSnapshot;
  diagnostics?: DeviceDiagnostics;
  frame?: ScreenFrame;
  busy: boolean;
  onRefresh(): void;
  onCapture(): void;
  onTouch(point: ScreenPoint): void;
  onRelease(point?: ScreenPoint): void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!frame || !canvas.current) return;
    drawRgb565(canvas.current, frame);
  }, [frame]);

  const ready = snapshot.connection === 'ready';
  const point = (event: React.PointerEvent<HTMLCanvasElement>): ScreenPoint => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(479, Math.floor((event.clientX - bounds.left) / bounds.width * 480))),
      y: Math.max(0, Math.min(319, Math.floor((event.clientY - bounds.top) / bounds.height * 320))),
    };
  };

  return <div className="device-layout">
    <section className="device-overview">
      <div className="panel-header"><div><Cpu size={14}/>ZS407 IDENTITY</div><span>{snapshot.identity?.usbIdentityVerified ? 'USB + FIRMWARE VERIFIED' : 'NOT VERIFIED'}</span></div>
      <div className="identity-hero"><div className="identity-chip"><span/><span/><span/><Cpu size={34}/></div><div><span className="section-kicker">INSTRUMENT PROFILE</span><h2>{snapshot.identity?.model ?? 'No instrument connected'}</h2><p>{snapshot.identity ? `${snapshot.identity.hardwareVersion} · ${snapshot.identity.firmwareVersion}` : 'Connect the tinySA Ultra+ to identify its exact hardware and firmware contract.'}</p></div></div>
      <div className="device-facts">
        <Fact icon={<Usb/>} label="USB identity" value={snapshot.identity ? `${snapshot.identity.port.vendorId ?? '—'}:${snapshot.identity.port.productId ?? '—'}` : '—'} detail={snapshot.identity?.port.product ?? snapshot.identity?.port.path ?? 'Disconnected'}/>
        <Fact icon={<Fingerprint/>} label="Firmware source" value={snapshot.identity?.firmwareSourceCommit.slice(0, 12) ?? '—'} detail="Pinned host contract"/>
        <Fact icon={<BatteryCharging/>} label="Battery" value={snapshot.telemetry ? `${(snapshot.telemetry.batteryMillivolts / 1_000).toFixed(2)} V` : '—'} detail={snapshot.telemetry ? `Device ID ${snapshot.telemetry.deviceId}` : 'Refresh diagnostics'}/>
        <Fact icon={<TerminalSquare/>} label="Shell surface" value={diagnostics ? `${diagnostics.commands.length} commands` : '—'} detail={snapshot.capabilities ? `${snapshot.capabilities.protocol.prompt} · CR terminated` : 'Not identified'}/>
      </div>
      <div className="device-actions"><button className="secondary" disabled={!ready || busy} onClick={onRefresh}><RefreshCw size={14}/>Refresh diagnostics</button><span>Readback operations are serialized with measurement commands.</span></div>
    </section>

    <section className="remote-screen-panel">
      <div className="panel-header"><div><MonitorUp size={14}/>PHYSICAL SCREEN</div><span>{frame ? `CAPTURED ${new Date(frame.capturedAt).toLocaleTimeString()}` : '480 × 320 · RGB565'}</span></div>
      <div className="screen-shell">
        <canvas
          ref={canvas}
          data-agent-control="device.remote-touch"
          data-agent-risk="high-impact"
          width="480"
          height="320"
          aria-label="TinySA physical screen mirror"
          onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); onTouch(point(event)); }}
          onPointerUp={(event) => { onRelease(point(event)); event.currentTarget.releasePointerCapture(event.pointerId); }}
          onPointerCancel={() => onRelease()}
        />
        {!frame && <div className="screen-empty"><MonitorUp size={26}/><strong>No frame captured</strong><span>Capture reads exactly 307,200 bytes from the device.</span></div>}
      </div>
      <div className="screen-actions"><button data-agent-control="device.capture-screen" className="primary" disabled={!ready || busy} onClick={onCapture}><MonitorUp size={14}/>Capture screen</button><p>Pointer input maps to firmware <code>touch</code> and <code>release</code> and can reach RF controls. Atom-driven touch always requires approval.</p></div>
    </section>

    <section className="capability-ledger"><div className="panel-header"><div><CheckCircle2 size={14}/>CAPABILITY LEDGER</div><span>{snapshot.capabilities?.evidence.toUpperCase() ?? 'UNAVAILABLE'}</span></div><div className="ledger-grid"><Ledger label="Analyzer" value={snapshot.capabilities ? `${snapshot.capabilities.sweepPoints.max} points · text/raw` : '—'}/><Ledger label="Screen" value={snapshot.capabilities?.screenCapture ? 'Capture + remote touch' : '—'}/><Ledger label="Generator readback" value={snapshot.capabilities?.generatorReadback === false ? 'Unavailable · commanded only' : '—'}/><Ledger label="Qualification" value={snapshot.capabilities?.qualification.replaceAll('-', ' ') ?? '—'}/></div></section>
  </div>;
}

function Fact({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) { return <div className="device-fact"><span>{icon}</span><div><small>{label}</small><strong>{value}</strong><em>{detail}</em></div></div>; }
function Ledger({ label, value }: { label: string; value: string }) { return <div><small>{label}</small><strong>{value}</strong></div>; }

function drawRgb565(canvas: HTMLCanvasElement, frame: ScreenFrame): void {
  if (frame.width !== 480 || frame.height !== 320 || frame.format !== 'rgb565le' || frame.pixels.length !== 307_200) {
    throw new Error('Screen frame violated the 480×320 RGB565 contract');
  }
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context is unavailable');
  const image = context.createImageData(frame.width, frame.height);
  for (let pixel = 0; pixel < frame.width * frame.height; pixel++) {
    const encoded = frame.pixels[pixel * 2]! | (frame.pixels[pixel * 2 + 1]! << 8);
    const target = pixel * 4;
    image.data[target] = Math.round(((encoded >> 11) & 0x1f) * 255 / 31);
    image.data[target + 1] = Math.round(((encoded >> 5) & 0x3f) * 255 / 63);
    image.data[target + 2] = Math.round((encoded & 0x1f) * 255 / 31);
    image.data[target + 3] = 255;
  }
  context.putImageData(image, 0, 0);
}
