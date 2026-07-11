import { Cable, Check, Cpu, LoaderCircle, RefreshCw, Usb, X } from 'lucide-react';
import type { PortCandidate } from '@tinysa/contracts';

export function ConnectionDialog({ ports, selectedId, busy, error, onSelect, onRefresh, onConnect, onDisconnect, connected, onClose }: {
  ports: readonly PortCandidate[]; selectedId?: string; busy: boolean; error?: string; connected: boolean;
  onSelect(id: string): void; onRefresh(): void; onConnect(): void; onDisconnect(): void; onClose(): void;
}) {
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><section className="connection-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-title">
    <div className="dialog-head"><h2 id="connection-title">Connect</h2><button className="icon-button" onClick={onClose} aria-label="Close"><X size={17}/></button></div>
    {connected ? <div className="connected-state"><div className="connected-glyph"><Check size={24}/></div><h3>Connected</h3><button className="danger-outline" onClick={onDisconnect}>Disconnect</button></div> : <>
      <div className="dialog-toolbar"><p>Available instruments</p><button className="text-button" onClick={onRefresh} disabled={busy}><RefreshCw size={13}/>Refresh</button></div>
      <div className="port-list">{ports.length === 0 ? <div className="no-ports"><Usb size={22}/><strong>No instrument backend found</strong><span>Connect a data-capable USB cable. The executable twin must also be available in the sibling Firmware repository.</span></div> : ports.map((port) => {
        const twin = port.execution === 'firmware-digital-twin';
        return <button key={port.id} className={`port-option ${selectedId === port.id ? 'selected' : ''}`} onClick={() => onSelect(port.id)}><span className="port-icon">{twin ? <Cpu size={17}/> : <Cable size={17}/>}</span><span><strong>{port.product ?? port.manufacturer ?? (twin ? 'ZS407 executable digital twin' : 'Serial device')}</strong><small>{twin ? 'Pinned firmware · Renode bridge · USB transactions not modeled' : `${port.path}${port.serialNumber ? ` · ${port.serialNumber}` : ''}`}</small></span><i>{selectedId === port.id && <Check size={15}/>}</i></button>;
      })}</div>
      {error && <div className="inline-error">{error}</div>}
      <div className="dialog-actions"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={!ports.length || busy} onClick={onConnect}>{busy ? <><LoaderCircle className="spin" size={14}/>Connecting</> : 'Connect'}</button></div>
    </>}
  </section></div>;
}
