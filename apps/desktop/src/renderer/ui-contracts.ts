import type { AnalyzerConfig, AtomizerInstrumentState, GeneratorConfig, InstrumentCandidate, Sweep } from '@tinysa/contracts';

export type WorkspaceId = 'spectrum' | 'detection' | 'classification' | 'generator' | 'device';
export type AcquisitionState = 'idle' | 'configuring' | 'retuning' | 'acquiring' | 'streaming' | 'complete' | 'failed';
export type ConnectionPanelState = 'closed' | 'selecting' | 'connecting' | 'failed';
export type InspectorSection = 'frequency' | 'acquisition' | 'detection' | 'model' | 'generator';
export type GeneratorOutputState = 'off' | 'on' | 'unknown';

export interface DesktopUiState {
  workspace: WorkspaceId;
  connectionPanel: ConnectionPanelState;
  acquisition: AcquisitionState;
  instrument: AtomizerInstrumentState;
  candidates: readonly InstrumentCandidate[];
  selectedCandidateId?: string;
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
export const INITIAL_INSTRUMENT_STATE: AtomizerInstrumentState = {
  schemaVersion: 1,
  startup: { status: 'not-started' },
  streaming: { status: 'stopped' },
  connectionCleanup: { status: 'not-required' },
};

export function assertWorkspaceTransition(from: WorkspaceId, to: WorkspaceId, generatorOutput: GeneratorOutputState): void {
  void from;
  if (to !== 'generator' && generatorOutput !== 'off') {
    throw new Error(generatorOutput === 'on'
      ? 'Disable RF output before leaving the generator workspace'
      : 'RF output state is unknown; inspect the instrument or disconnect before leaving the generator workspace');
  }
}

export function selectedCandidate(state: DesktopUiState): InstrumentCandidate | undefined {
  return state.candidates.find((candidate) => instrumentCandidateUiKey(candidate) === state.selectedCandidateId);
}

export function instrumentCandidateUiKey(candidate: InstrumentCandidate): string {
  return JSON.stringify([candidate.discoveryRevision, candidate.driverId, candidate.sourceKind, candidate.candidateId]);
}

export function sameInstrumentCandidateDescriptor(left: InstrumentCandidate, right: InstrumentCandidate): boolean {
  const { discoveryRevision: _leftRevision, ...leftDescriptor } = left;
  const { discoveryRevision: _rightRevision, ...rightDescriptor } = right;
  return JSON.stringify(leftDescriptor) === JSON.stringify(rightDescriptor);
}
