import type { AnalyzerConfig, DeviceSnapshot, GeneratorConfig, PortCandidate, Sweep } from '@tinysa/contracts';

export type WorkspaceId = 'spectrum' | 'detection' | 'classification' | 'generator';
export type AcquisitionState = 'idle' | 'configuring' | 'acquiring' | 'complete' | 'failed';
export type ConnectionPanelState = 'closed' | 'selecting' | 'connecting' | 'failed';
export type InspectorSection = 'frequency' | 'acquisition' | 'detection' | 'model' | 'generator';

export interface DesktopUiState {
  workspace: WorkspaceId;
  connectionPanel: ConnectionPanelState;
  acquisition: AcquisitionState;
  snapshot: DeviceSnapshot;
  ports: readonly PortCandidate[];
  selectedPortId?: string;
  analyzer: AnalyzerConfig;
  generator: GeneratorConfig;
  sweep?: Sweep;
  error?: string;
}

export const DEFAULT_ANALYZER: AnalyzerConfig = {
  startHz: 88_000_000, stopHz: 108_000_000, points: 450, attenuationDb: 'auto'
};
export const DEFAULT_GENERATOR: GeneratorConfig = {
  frequencyHz: 100_000_000, levelDbm: -40, modulation: 'off'
};
export const DISCONNECTED_SNAPSHOT: DeviceSnapshot = {
  connection: 'disconnected', mode: 'idle', generatorOutput: 'off', verification: 'stale'
};

export const workspaceCopy: Record<WorkspaceId, { eyebrow: string; title: string; description: string }> = {
  spectrum: { eyebrow: 'OBSERVE / SPECTRUM', title: 'Spectrum analyzer', description: 'Inspect the RF landscape with precise, provenance-preserving sweeps.' },
  detection: { eyebrow: 'ANALYZE / DETECTION', title: 'Signal detection', description: 'Surface emissions using an adaptive noise floor and contiguous event segmentation.' },
  classification: { eyebrow: 'ANALYZE / CLASSIFICATION', title: 'Waveform classification', description: 'Rank waveform families with calibrated confidence and open-set rejection.' },
  generator: { eyebrow: 'GENERATE / OUTPUT', title: 'Signal generator', description: 'Configure RF output deliberately with visible state and bounded controls.' }
};

export function assertWorkspaceTransition(from: WorkspaceId, to: WorkspaceId, generatorOutput: DeviceSnapshot['generatorOutput']): void {
  if (from === 'generator' && to !== 'generator' && generatorOutput === 'on') {
    throw new Error('Disable RF output before leaving the generator workspace');
  }
}

export function selectedPort(state: DesktopUiState): PortCandidate | undefined {
  return state.ports.find((port) => port.id === state.selectedPortId);
}
