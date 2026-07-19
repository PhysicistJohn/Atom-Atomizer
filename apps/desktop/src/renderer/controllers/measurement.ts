import {
  channelMeasurementConfigurationSchema,
  envelopeStftConfigurationSchema,
  firmwareTraceVisibilitySchema,
  markerConfigurationSchema,
  markerSearchConfigurationSchema,
  spectrumDisplayConfigurationSchema,
  traceBankConfigurationSchema,
  traceConfigurationSchema,
  waterfallConfigurationSchema,
  zeroSpanConfigSchema,
  type ChannelMeasurementConfiguration,
  type EnvelopeStftConfiguration,
  type FirmwareTraceId,
  type FirmwareTraceVisibility,
  type MarkerConfiguration,
  type MarkerId,
  type MarkerSearchAction,
  type MarkerSearchConfiguration,
  type MeasurementViewId,
  type SpectrumDisplayConfiguration,
  type TraceConfiguration,
  type TraceId,
  type ZeroSpanConfig,
} from '@tinysa/contracts';
import { autoScaleSpectrum, computeEnvelopeStft, measureChannel, readMarkers, searchMarker } from '@tinysa/analysis';
import { visibleMeasurementView } from '../store.js';
import { errorMessage, sameStructuredValue, type RendererKernel } from './kernel.js';

export class MeasurementController {
  constructor(private readonly k: RendererKernel) {}

  commitZeroSpanConfiguration(input: ZeroSpanConfig): ZeroSpanConfig {
    const k = this.k;
    const next = zeroSpanConfigSchema.parse(input);
    if (sameStructuredValue(next, k.state.zeroConfig)) return k.state.zeroConfig;
    k.set({ zeroConfig: next });
    return next;
  }

  updateZeroSpanConfiguration(update: (current: ZeroSpanConfig) => ZeroSpanConfig): ZeroSpanConfig {
    return this.commitZeroSpanConfiguration(update(this.k.state.zeroConfig));
  }

  applyTrace(input: TraceConfiguration): TraceConfiguration {
    const k = this.k;
    const trace = traceConfigurationSchema.parse(input);
    const next = traceBankConfigurationSchema.parse(k.state.traceConfiguration.map((item) => item.id === trace.id ? trace : item));
    k.traceAccumulator.current.configure(next);
    k.set({
      traceConfiguration: next,
      traceFrames: k.traceAccumulator.current.frames(),
      error: undefined,
    });
    return trace;
  }

  configureTrace(input: TraceConfiguration): void {
    try { this.applyTrace(input); }
    catch (value) { this.k.set({ error: `Trace configuration failed: ${errorMessage(value)}` }); }
  }

  resetTrace(traceId: TraceId): void {
    const k = this.k;
    try {
      k.traceAccumulator.current.reset(traceId);
      k.set({ traceFrames: k.traceAccumulator.current.frames(), notice: `Trace ${traceId} memory cleared` });
    } catch (value) { k.set({ error: `Trace reset failed: ${errorMessage(value)}` }); }
  }

  configureFirmwareTraceVisibility(traceId: FirmwareTraceId, visible: boolean): FirmwareTraceVisibility {
    const k = this.k;
    try {
      const current = k.state.visibleFirmwareTraceIds;
      const next = firmwareTraceVisibilitySchema.parse(visible
        ? [...new Set([...current, traceId])].sort((left, right) => left - right)
        : current.filter((item) => item !== traceId));
      k.set({ visibleFirmwareTraceIds: next, error: undefined });
      return next;
    } catch (value) {
      k.set({ error: `Instrument trace visibility failed: ${errorMessage(value)}` });
      throw value;
    }
  }

  applyMarker(input: MarkerConfiguration): MarkerConfiguration {
    const k = this.k;
    const marker = markerConfigurationSchema.parse(input);
    let next = k.state.markers.map((item) => item.id === marker.id ? marker : item);
    if (marker.mode === 'delta' && marker.referenceMarkerId !== undefined) {
      next = next.map((item) => item.id === marker.referenceMarkerId && !item.enabled ? { ...item, enabled: true } : item);
    }
    k.set({ markers: next, activeMarkerId: marker.id, error: undefined });
    return marker;
  }

  previewMarkerReading(marker: MarkerConfiguration) {
    const k = this.k;
    let preview = k.state.markers.map((item) => item.id === marker.id ? marker : item);
    if (marker.mode === 'delta' && marker.referenceMarkerId !== undefined) {
      preview = preview.map((item) => item.id === marker.referenceMarkerId && !item.enabled
        ? { ...item, enabled: true }
        : item);
    }
    const frames = k.traceAccumulator.current.frames();
    return readMarkers(preview, frames, k.state.detections)
      .find((reading) => reading.markerId === marker.id);
  }

  configureMarker(input: MarkerConfiguration): void {
    try { this.applyMarker(input); }
    catch (value) { this.k.set({ error: `Marker configuration failed: ${errorMessage(value)}` }); }
  }

  placeActiveMarker(frequencyHz: number): boolean {
    const k = this.k;
    try {
      const markerId = k.state.activeMarkerId;
      const marker = k.state.markers.find((item) => item.id === markerId);
      if (!marker) throw new Error(`Active marker M${markerId} is unavailable`);
      const applied = this.applyMarker({ ...marker, enabled: true, tracking: 'fixed', frequencyHz });
      const committed = k.state.markers.find((item) => item.id === markerId);
      return applied.frequencyHz === frequencyHz
        && committed?.enabled === true
        && committed.tracking === 'fixed'
        && committed.frequencyHz === frequencyHz;
    } catch (value) {
      k.set({ error: `Marker configuration failed: ${errorMessage(value)}` });
      return false;
    }
  }

  runMarkerSearch(action: MarkerSearchAction, markerId: MarkerId = this.k.state.activeMarkerId): void {
    const k = this.k;
    try {
      const marker = k.state.markers.find((item) => item.id === markerId);
      if (!marker) throw new Error(`Marker M${markerId} is unavailable`);
      const frame = k.traceAccumulator.current.frames().find((item) => item.traceId === marker.traceId);
      if (!frame) throw new Error(`Trace ${marker.traceId} has no data; enable and acquire it first`);
      const frequencyHz = searchMarker(frame, marker.frequencyHz, action, k.state.markerSearchConfiguration, k.state.detections);
      this.applyMarker({ ...marker, enabled: true, tracking: action === 'peak' ? 'peak' : 'fixed', frequencyHz });
      k.set({ notice: `M${marker.id} moved by ${action.replace('-', ' ')} search` });
    } catch (value) { k.set({ error: `Marker search failed: ${errorMessage(value)}` }); }
  }

  applyMarkerSearch(input: MarkerSearchConfiguration): MarkerSearchConfiguration {
    const configuration = markerSearchConfigurationSchema.parse(input);
    this.k.set({ markerSearchConfiguration: configuration, error: undefined });
    return configuration;
  }

  configureMarkerSearch(input: MarkerSearchConfiguration): void {
    try { this.applyMarkerSearch(input); }
    catch (value) { this.k.set({ error: `Marker search criteria failed: ${errorMessage(value)}` }); }
  }

  applyDisplay(input: SpectrumDisplayConfiguration): SpectrumDisplayConfiguration {
    const configuration = spectrumDisplayConfigurationSchema.parse(input);
    this.k.set({ displayConfiguration: configuration, error: undefined });
    return configuration;
  }

  configureDisplay(input: SpectrumDisplayConfiguration): void {
    try { this.applyDisplay(input); }
    catch (value) { this.k.set({ error: `Display configuration failed: ${errorMessage(value)}` }); }
  }

  applyMeasurementView(input: MeasurementViewId): MeasurementViewId {
    const next = visibleMeasurementView(input);
    this.k.applyWorkspace('spectrum');
    this.k.set({ measurementView: next });
    return next;
  }

  changeMeasurementView(input: MeasurementViewId): void {
    try { this.applyMeasurementView(input); }
    catch (value) { this.k.set({ error: `Measurement view failed: ${errorMessage(value)}` }); }
  }

  applyWaterfall(input: import('@tinysa/contracts').WaterfallConfiguration) {
    const configuration = waterfallConfigurationSchema.parse(input);
    this.k.set({ waterfallConfiguration: configuration, error: undefined });
    return configuration;
  }

  configureWaterfall(input: import('@tinysa/contracts').WaterfallConfiguration): void {
    try { this.applyWaterfall(input); }
    catch (value) { this.k.set({ error: `Waterfall configuration failed: ${errorMessage(value)}` }); }
  }

  applyChannelMeasurement(input: ChannelMeasurementConfiguration): ChannelMeasurementConfiguration {
    const configuration = channelMeasurementConfigurationSchema.parse(input);
    this.k.set({ channelConfiguration: configuration, error: undefined });
    return configuration;
  }

  configureChannelMeasurement(input: ChannelMeasurementConfiguration): void {
    try { this.applyChannelMeasurement(input); }
    catch (value) { this.k.set({ error: `Channel measurement configuration failed: ${errorMessage(value)}` }); }
  }

  applyEnvelopeStft(input: EnvelopeStftConfiguration): EnvelopeStftConfiguration {
    const configuration = envelopeStftConfigurationSchema.parse(input);
    this.k.set({ stftConfiguration: configuration, error: undefined });
    return configuration;
  }

  requireChannelMeasurement() {
    const latestSweep = this.k.state.sweep;
    if (!latestSweep) throw new Error('Acquire a complete spectrum sweep before reading channel measurements');
    return measureChannel(latestSweep, this.k.state.channelConfiguration);
  }

  requireEnvelopeStft() {
    const capture = this.k.state.zeroCapture;
    if (!capture) throw new Error('Acquire a complete zero-span capture before reading the envelope STFT');
    return computeEnvelopeStft(capture, this.k.state.stftConfiguration);
  }

  autoScaleDisplay(): void {
    const latestSweep = this.k.state.sweep;
    if (!latestSweep) { this.k.set({ error: 'Acquire a sweep before auto-scaling the display' }); return; }
    this.configureDisplay(autoScaleSpectrum(latestSweep));
  }
}
