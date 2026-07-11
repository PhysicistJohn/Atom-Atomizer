import type { AnalyzerConfig, DeviceSnapshot, GeneratorConfig, PortCandidate, Sweep } from '@tinysa/contracts';

export type WorkspaceId = 'spectrum' | 'detection' | 'classification' | 'generator' | 'device';
export type AcquisitionState = 'idle' | 'configuring' | 'acquiring' | 'streaming' | 'complete' | 'failed';
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
  startHz: 88_000_000,
  stopHz: 108_000_000,
  points: 450,
  acquisitionFormat: 'raw',
  rbwKhz: 'auto',
  attenuationDb: 'auto',
  sweepTimeSeconds: 'auto',
  detector: 'sample',
  spurRejection: 'auto',
  lna: 'off',
  avoidSpurs: 'auto',
  trigger: { mode: 'auto' },
};
export const DEFAULT_GENERATOR: GeneratorConfig = {
  frequencyHz: 100_000_000,
  levelDbm: -40,
  path: 'normal',
  modulation: 'off',
  modulationFrequencyHz: 1_000,
  amDepthPercent: 50,
  fmDeviationHz: 25_000,
};
export const DISCONNECTED_SNAPSHOT: DeviceSnapshot = {
  connection: 'disconnected', mode: 'idle', generatorOutput: 'off', verification: 'stale'
};

export function assertWorkspaceTransition(from: WorkspaceId, to: WorkspaceId, generatorOutput: DeviceSnapshot['generatorOutput']): void {
  if (from === 'generator' && to !== 'generator' && generatorOutput === 'on') {
    throw new Error('Disable RF output before leaving the generator workspace');
  }
}

export function selectedPort(state: DesktopUiState): PortCandidate | undefined {
  return state.ports.find((port) => port.id === state.selectedPortId);
}
