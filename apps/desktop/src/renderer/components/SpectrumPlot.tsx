import { Activity, Orbit } from 'lucide-react';
import type { DetectedSignal, Sweep } from '@tinysa/contracts';
import { formatFrequency, formatLevel } from '../format.js';
import { AtomicMark } from './AtomicMark.js';

export function SpectrumPlot({ sweep, detections = [], busy }: { sweep?: Sweep; detections?: readonly DetectedSignal[]; busy: boolean }) {
  const width = 1200, height = 430, minDbm = -120, maxDbm = -20;
  const peakIndex=sweep?sweep.powerDbm.reduce((best,value,index)=>value>sweep.powerDbm[best]! ? index : best,0):-1;
  const peakDbm=sweep&&peakIndex>=0?sweep.powerDbm[peakIndex]:undefined;
  const peakHz=sweep&&peakIndex>=0?sweep.frequencyHz[peakIndex]:undefined;
  const peakX=sweep&&peakIndex>=0?peakIndex/Math.max(1,sweep.powerDbm.length-1)*width:0;
  const peakY=peakDbm===undefined?0:height-(Math.min(maxDbm,Math.max(minDbm,peakDbm))-minDbm)/(maxDbm-minDbm)*height;
  return <section className="plot-panel" aria-label="Spectrum plot">
    <div className="panel-header"><div><span className="live-indicator"/><strong>Live spectrum</strong><small>TRACE 01</small></div><div className="plot-meta"><span><Activity size={13}/>{sweep?`${sweep.frequencyHz.length} bins`:'Awaiting trace'}</span><span><Orbit size={13}/>{detections.length} signals</span></div></div>
    <div className={`plot-canvas ${busy ? 'is-loading' : ''}`}>
      <div className="y-labels"><span>-20</span><span>-45</span><span>-70</span><span>-95</span><span>-120</span><em>dBm</em></div>
      {!sweep ? <div className="plot-empty"><div className="empty-atom"><AtomicMark size={76}/></div><strong>The field is quiet</strong><p>Connect an instrument and acquire a sweep.</p></div> : <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-label="Measured power by frequency">
        <defs><linearGradient id="trace-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#79f2c3" stopOpacity=".24"/><stop offset=".6" stopColor="#65dce3" stopOpacity=".055"/><stop offset="1" stopColor="#8d7cff" stopOpacity="0"/></linearGradient><linearGradient id="trace-stroke" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#5edac9"/><stop offset=".52" stopColor="#8affc8"/><stop offset="1" stopColor="#9e8cff"/></linearGradient><filter id="trace-glow"><feGaussianBlur stdDeviation="2.4" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
        {Array.from({length: 9},(_,i)=><line key={`v${i}`} x1={i*width/8} x2={i*width/8} y1="0" y2={height} className="plot-grid"/>)}
        {Array.from({length: 5},(_,i)=><line key={`h${i}`} x1="0" x2={width} y1={i*height/4} y2={i*height/4} className="plot-grid"/>)}
        {detections.map((d) => { const x=(d.startHz-sweep.actualStartHz)/(sweep.actualStopHz-sweep.actualStartHz)*width; const w=Math.max(3,d.bandwidthHz/(sweep.actualStopHz-sweep.actualStartHz)*width); return <g key={d.id}><rect x={x} y="0" width={w} height={height} className="detection-band"/><line x1={x+w/2} x2={x+w/2} y1="12" y2={height} className="detection-center"/></g>; })}
        <polygon points={`0,${height} ${tracePoints(sweep, width, height, minDbm, maxDbm)} ${width},${height}`} fill="url(#trace-fill)"/>
        <polyline points={tracePoints(sweep, width, height, minDbm, maxDbm)} className="trace-line" vectorEffect="non-scaling-stroke" filter="url(#trace-glow)"/>
        <line x1={peakX} x2={peakX} y1={Math.max(0,peakY-34)} y2={height} className="peak-stem" vectorEffect="non-scaling-stroke"/>
        <circle cx={peakX} cy={peakY} r="5" className="peak-node" vectorEffect="non-scaling-stroke"/>
      </svg>}
      {sweep&&peakDbm!==undefined&&peakHz!==undefined&&<div className="peak-readout" style={{left:`${Math.min(88,Math.max(12,peakX/width*100))}%`,top:`${Math.min(82,Math.max(17,peakY/height*100))}%`}}><small>M1</small><strong>{formatLevel(peakDbm)}</strong><span>{formatFrequency(peakHz)}</span></div>}
      {sweep && <div className="x-labels"><span>{formatFrequency(sweep.actualStartHz)}</span><span>{formatFrequency((sweep.actualStartHz+sweep.actualStopHz)/2)}</span><span>{formatFrequency(sweep.actualStopHz)}</span></div>}
    </div>
  </section>;
}
function tracePoints(sweep: Sweep, width: number, height: number, min: number, max: number): string { return sweep.powerDbm.map((value,i)=>`${i/Math.max(1,sweep.powerDbm.length-1)*width},${height-(Math.min(max,Math.max(min,value))-min)/(max-min)*height}`).join(' '); }
