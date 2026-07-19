import { useMemo, type ReactNode } from 'react';
import { Download } from 'lucide-react';
import { readMarkers } from '@tinysa/analysis';
import { MeasurementWorkspace } from '../components/MeasurementWorkspace.js';
import { selectBusy, selectSpectrumCapability, useStore } from '../store.js';
import type { RendererRuntime } from '../AppShell.js';

/** Export CSV / `{ }` JSON command block (rendered only when a sweep exists). */
export function MeasurementActions({ runtime }: { runtime: RendererRuntime }) {
  const { features } = runtime;
  return <div className="measurement-actions">
      <button data-agent-control="export.csv" className="secondary compact icon-only" aria-label="Export CSV" title="Export CSV" onClick={() => void features.exportLatestFromUi('csv')}><Download size={14}/><span>CSV</span></button>
      <button data-agent-control="export.json" className="secondary compact icon-only" aria-label="Export JSON" title="Export JSON" onClick={() => void features.exportLatestFromUi('json')}><span>{'{ }'}</span></button>
  </div>;
}

export function MeasurementContainer({ runtime, measurementActions }: {
  runtime: RendererRuntime;
  measurementActions: ReactNode;
}) {
  const s = useStore(runtime.store, (state) => state);
  const { acquisition, measurement, kernel } = runtime;
  const busy = selectBusy(s, kernel.instrumentTransactionOwner.current);
  const markerReadings = useMemo(
    () => readMarkers(s.markers, s.traceFrames, s.detections),
    [s.markers, s.traceFrames, s.detections],
  );
  return <MeasurementWorkspace
    measurementActions={measurementActions}
    view={s.measurementView}
    analyzer={s.analyzer} spectrumCapability={selectSpectrumCapability(s)} busy={busy} streaming={s.continuous} onAnalyzer={(configuration) => void acquisition.updateAnalyzerFromUi(configuration)}
    sweep={s.sweep} history={s.history} detections={s.detections} acquisition={s.acquisition}
    traces={s.traceConfiguration} frames={s.traceFrames} firmwareFrames={s.firmwareTraceFrames} visibleFirmwareTraceIds={s.visibleFirmwareTraceIds} onFirmwareTraceVisibility={(traceId, visible) => measurement.configureFirmwareTraceVisibility(traceId, visible)} activeTraceId={s.activeTraceId} onActiveTrace={(traceId) => runtime.store.set({ activeTraceId: traceId })} markers={s.markers} readings={markerReadings}
    activeMarkerId={s.activeMarkerId} markerSearch={s.markerSearchConfiguration} display={s.displayConfiguration}
    onTrace={(configuration) => measurement.configureTrace(configuration)} onTraceReset={(traceId) => measurement.resetTrace(traceId)} onMarker={(configuration) => measurement.configureMarker(configuration)} onActiveMarker={(markerId) => runtime.store.set({ activeMarkerId: markerId })}
    onSearch={(action) => measurement.runMarkerSearch(action)} onSearchConfiguration={(configuration) => measurement.configureMarkerSearch(configuration)} onDisplay={(configuration) => measurement.configureDisplay(configuration)}
    onAutoScale={() => measurement.autoScaleDisplay()} onMarkerPlace={(frequencyHz) => measurement.placeActiveMarker(frequencyHz)}
    waterfall={s.waterfallConfiguration} onWaterfall={(configuration) => measurement.configureWaterfall(configuration)}
    channel={s.channelConfiguration} onChannel={(configuration) => measurement.configureChannelMeasurement(configuration)}
  />;
}
