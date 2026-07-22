import { Cpu, ScanSearch } from 'lucide-react';
import type { EnvelopeClassification } from '@tinysa/analysis';
import type { DetectedSignal, SignalDetectionConfig, Sweep, ZeroSpanCapture, ZeroSpanConfig } from '@tinysa/contracts';
import type { ModulationClassification } from '../embedding-classifier-runtime.js';
import { CaptureEvidenceStrip, DetectionSettings, type DetectedPowerCapability } from './DetectorControls.js';

const MODULATION_LABELS: Record<string, string> = {
  cw: 'Continuous wave', am: 'AM', fm: 'FM',
  gsm: 'GSM / GERAN', ofdm: 'OFDM', dsss: 'DSSS', bluetooth: 'Bluetooth', unknown: 'Unknown',
};
function modLabel(id: string): string { return MODULATION_LABELS[id] ?? id.toUpperCase(); }
function leafLabel(id: string): string { return id.replace(/-like$/, '').replaceAll('-', ' '); }

/**
 * The Detect panel: the browser-native embedding modulation classifier plus the
 * shared signal-detector settings and detected-power envelope capture. Runs on
 * complex I/Q (SDR/SignalLab) or a scalar power spectrum (tinySA) — whichever the
 * connected instrument provides — and reports the modulation family, confidence,
 * candidate distribution, and the fused protocol-leaf guess.
 */
export function DetectWorkspace({
  modulation, pending, source, live = false, evidenceLooks = 0,
  sweep, detectionConfig, detectorBusy, onDetectionConfig,
  zeroConfig, zeroCapture, envelope, detectedPowerCapability, captureUnavailableReason, captureTarget, busy, onAcquireZero,
}: {
  modulation?: ModulationClassification;
  pending: boolean;
  source: 'iq' | 'scalar' | 'none';
  live?: boolean;
  evidenceLooks?: number;
  sweep?: Sweep;
  detectionConfig?: SignalDetectionConfig;
  detectorBusy: boolean;
  onDetectionConfig(config: SignalDetectionConfig): void;
  zeroConfig?: ZeroSpanConfig;
  zeroCapture?: ZeroSpanCapture;
  envelope?: EnvelopeClassification;
  detectedPowerCapability?: DetectedPowerCapability;
  captureUnavailableReason?: string;
  captureTarget?: DetectedSignal;
  busy: boolean;
  onAcquireZero(): void;
}) {
  return (
    <div className="detect-workspace" role="region" aria-label="Modulation classifier">
      <section className="detect-stage">
        <header className="detect-header">
          <div><ScanSearch size={16} /><span><strong>Modulation classifier</strong><small>Metric-embedding · synthetic-trained</small></span></div>
          {modulation && (
            <span className="detect-flavor">
              {modulation.flavor === 'iq' ? 'COMPLEX I/Q' : 'MAGNITUDE · SCALAR'}
              {live ? ` · LIVE ${evidenceLooks} ${evidenceLooks === 1 ? 'LOOK' : 'LOOKS'}` : evidenceLooks > 1 ? ` · ${evidenceLooks} LOOKS` : ''}
            </span>
          )}
        </header>

        {source === 'none' && (
          <div className="detect-empty">
            <Cpu size={24} />
            <p>Acquire a complex-I/Q buffer, or run a spectrum sweep with a detected signal, to classify the modulation.</p>
          </div>
        )}
        {source !== 'none' && pending && !modulation && (
          <div className="detect-empty"><p>Classifying…</p></div>
        )}

        {modulation && (
          <div className="detect-result">
            <div className="detect-primary">
              <span className={`detect-conf${modulation.isUnknown ? ' unknown' : ''}`}>
                {modulation.isUnknown ? 'UNKNOWN' : `${Math.round(modulation.confidence * 100)}%`}
              </span>
              <span className="detect-label">{modulation.isUnknown ? 'Unknown signal' : modLabel(modulation.modulation)}</span>
              {modulation.topLeaf && <span className="detect-leaf">likely {leafLabel(modulation.topLeaf.label)}</span>}
            </div>
            <div className="detect-bars">
              {modulation.candidates.map((c) => (
                <div key={c.label} className="detect-bar">
                  <span>{modLabel(c.label)}</span>
                  <div className="detect-track"><div style={{ width: `${Math.round(c.confidence * 100)}%` }} /></div>
                  <em>{Math.round(c.confidence * 100)}%</em>
                </div>
              ))}
            </div>
            <p className="detect-note">
              Occupied bandwidth ≈ {(modulation.bwFraction * 100).toFixed(0)}% of {modulation.flavor === 'iq' ? 'sample rate' : 'span'} ·
              modulation family, not a protocol or emitter identity.
            </p>
          </div>
        )}
      </section>

      <aside className="detect-config">
        {detectionConfig && <DetectionSettings sweep={sweep} config={detectionConfig} busy={detectorBusy} onConfig={onDetectionConfig} />}
        {zeroConfig && <CaptureEvidenceStrip
          configuration={zeroConfig}
          capture={zeroCapture}
          envelope={envelope}
          capability={detectedPowerCapability}
          unavailableReason={captureUnavailableReason}
          target={captureTarget}
          busy={busy}
          onAcquire={onAcquireZero}
        />}
      </aside>
    </div>
  );
}
