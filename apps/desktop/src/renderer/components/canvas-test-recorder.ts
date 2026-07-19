/**
 * Test-only 2d-context recorder for the canvas plot rebuild. Installs a
 * prototype-level `getContext` stub returning one recording context per
 * canvas element; tests assert on the recorded draw operations (the canvas
 * draw-spy replacing the retired SVG-node queries).
 */
export interface RecordedSegment { x1: number; y1: number; x2: number; y2: number }
export interface RecordedStroke {
  segments: RecordedSegment[];
  strokeStyle: unknown;
  lineWidth: number;
  globalAlpha: number;
  lineDash: readonly number[];
  shadowBlur: number;
}
export interface RecordedFillRect { x: number; y: number; width: number; height: number; fillStyle: unknown }
export interface RecordedPathFill { segments: RecordedSegment[]; fillStyle: unknown }

export interface RecordingContext2D {
  canvas: HTMLCanvasElement;
  strokes: RecordedStroke[];
  fillRects: RecordedFillRect[];
  pathFills: RecordedPathFill[];
  clearRectCalls: number;
  drawImageCalls: unknown[][];
  putImageDataCalls: unknown[][];
  gradients: { stops: [number, string][] }[];
  reset(): void;
}

interface MutableStyle {
  strokeStyle: unknown;
  fillStyle: unknown;
  globalAlpha: number;
  lineWidth: number;
  lineDash: readonly number[];
  lineDashOffset: number;
  shadowBlur: number;
  shadowColor: string;
  lineJoin: string;
  lineCap: string;
  imageSmoothingEnabled: boolean;
}

export function installRecordingCanvas(): { contextFor(canvas: HTMLCanvasElement): RecordingContext2D | undefined; contexts: RecordingContext2D[]; restore(): void } {
  const contexts = new Map<HTMLCanvasElement, RecordingContext2D & Record<string, unknown>>();
  const original = HTMLCanvasElement.prototype.getContext;
  const makeContext = (canvas: HTMLCanvasElement) => {
    const style: MutableStyle = {
      strokeStyle: '#000', fillStyle: '#000', globalAlpha: 1, lineWidth: 1,
      lineDash: [], lineDashOffset: 0, shadowBlur: 0, shadowColor: '',
      lineJoin: 'miter', lineCap: 'butt', imageSmoothingEnabled: true,
    };
    const stack: MutableStyle[] = [];
    let path: RecordedSegment[] = [];
    let cursor: { x: number; y: number } | undefined;
    let pathStart: { x: number; y: number } | undefined;
    const recording: RecordingContext2D & Record<string, unknown> = {
      canvas,
      strokes: [],
      fillRects: [],
      pathFills: [],
      clearRectCalls: 0,
      drawImageCalls: [],
      putImageDataCalls: [],
      gradients: [],
      reset() {
        this.strokes = []; this.fillRects = []; this.pathFills = [];
        this.clearRectCalls = 0; this.drawImageCalls = []; this.putImageDataCalls = [];
        this.gradients = [];
      },
      save() { stack.push({ ...style }); },
      restore() { Object.assign(style, stack.pop() ?? style); },
      clearRect() { recording.clearRectCalls++; },
      fillRect(x: number, y: number, width: number, height: number) {
        recording.fillRects.push({ x, y, width, height, fillStyle: style.fillStyle });
      },
      strokeRect(x: number, y: number, width: number, height: number) {
        recording.strokes.push({
          segments: [
            { x1: x, y1: y, x2: x + width, y2: y },
            { x1: x + width, y1: y, x2: x + width, y2: y + height },
            { x1: x + width, y1: y + height, x2: x, y2: y + height },
            { x1: x, y1: y + height, x2: x, y2: y },
          ],
          strokeStyle: style.strokeStyle, lineWidth: style.lineWidth,
          globalAlpha: style.globalAlpha, lineDash: style.lineDash, shadowBlur: style.shadowBlur,
        });
      },
      beginPath() { path = []; cursor = undefined; pathStart = undefined; },
      moveTo(x: number, y: number) { cursor = { x, y }; pathStart = { x, y }; },
      lineTo(x: number, y: number) {
        if (cursor) path.push({ x1: cursor.x, y1: cursor.y, x2: x, y2: y });
        cursor = { x, y };
        pathStart ??= { x, y };
      },
      closePath() {
        if (cursor && pathStart) path.push({ x1: cursor.x, y1: cursor.y, x2: pathStart.x, y2: pathStart.y });
        cursor = pathStart;
      },
      stroke() {
        recording.strokes.push({
          segments: [...path],
          strokeStyle: style.strokeStyle, lineWidth: style.lineWidth,
          globalAlpha: style.globalAlpha, lineDash: style.lineDash, shadowBlur: style.shadowBlur,
        });
      },
      fill() { recording.pathFills.push({ segments: [...path], fillStyle: style.fillStyle }); },
      setLineDash(dash: readonly number[]) { style.lineDash = dash; },
      getLineDash() { return [...style.lineDash]; },
      createLinearGradient() {
        const gradient = { stops: [] as [number, string][], addColorStop(offset: number, color: string) { gradient.stops.push([offset, color]); } };
        recording.gradients.push(gradient);
        return gradient;
      },
      drawImage(...args: unknown[]) { recording.drawImageCalls.push(args); },
      putImageData(...args: unknown[]) { recording.putImageDataCalls.push(args); },
    };
    for (const key of ['strokeStyle', 'fillStyle', 'globalAlpha', 'lineWidth', 'lineDashOffset', 'shadowBlur', 'shadowColor', 'lineJoin', 'lineCap', 'imageSmoothingEnabled'] as const) {
      Object.defineProperty(recording, key, {
        get: () => style[key],
        set: (value) => { (style as unknown as Record<string, unknown>)[key] = value; },
      });
    }
    return recording;
  };
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string) {
    if (kind !== '2d') return null;
    let context = contexts.get(this);
    if (!context) {
      context = makeContext(this);
      contexts.set(this, context);
    }
    return context as unknown as CanvasRenderingContext2D;
  } as typeof HTMLCanvasElement.prototype.getContext;
  return {
    contextFor: (canvas) => contexts.get(canvas),
    get contexts() { return [...contexts.values()]; },
    restore() { HTMLCanvasElement.prototype.getContext = original; },
  };
}

/** Await one animation frame so the plot's rAF latest-wins draw has run. */
export function flushPlotFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/** Crisp strokes whose segments form one connected polyline chain (host and
 * firmware traces; the active trace's blurred glow under-pass is excluded). */
export function polylineStrokes(context: RecordingContext2D): RecordedStroke[] {
  return context.strokes.filter((stroke) => stroke.shadowBlur === 0
    && stroke.segments.length >= 2
    && stroke.segments.every((segment, index) => index === 0
      || (segment.x1 === stroke.segments[index - 1]!.x2 && segment.y1 === stroke.segments[index - 1]!.y2))
    && stroke.segments.every((segment) => segment.x2 >= segment.x1)
    && stroke.segments.some((segment) => segment.x2 !== segment.x1));
}

/** Single-segment vertical strokes reaching the plot floor with the marker
 * dash (3 5), excluding detection-center verticals (5 5 dash from y=0). */
export function markerLineStrokes(context: RecordingContext2D, height: number): RecordedStroke[] {
  return context.strokes.filter((stroke) => stroke.segments.length === 1
    && stroke.segments[0]!.x1 === stroke.segments[0]!.x2
    && stroke.segments[0]!.y2 === height
    && stroke.lineDash.length === 2
    && stroke.lineDash[0]! < stroke.lineDash[1]!);
}

/** Detection-center verticals spanning the full plot height. */
export function detectionCenterStrokes(context: RecordingContext2D, height: number): RecordedStroke[] {
  return context.strokes.filter((stroke) => stroke.segments.length === 1
    && stroke.segments[0]!.x1 === stroke.segments[0]!.x2
    && stroke.segments[0]!.y1 === 0
    && stroke.segments[0]!.y2 === height
    && (stroke.lineDash.length === 0 || stroke.lineDash[0] === stroke.lineDash[1]));
}

/** The active-marker 3 dB bracket: one horizontal span plus two edge ticks. */
export function bracketStrokes(context: RecordingContext2D): RecordedStroke[] {
  return context.strokes.filter((stroke) => stroke.segments.length === 3
    && stroke.segments[0]!.y1 === stroke.segments[0]!.y2
    && stroke.segments[1]!.x1 === stroke.segments[1]!.x2
    && stroke.segments[2]!.x1 === stroke.segments[2]!.x2);
}

export function allRecordedCoordinates(context: RecordingContext2D): number[] {
  return [
    ...context.strokes.flatMap((stroke) => stroke.segments.flatMap((segment) => [segment.x1, segment.y1, segment.x2, segment.y2])),
    ...context.fillRects.flatMap((rect) => [rect.x, rect.y, rect.width, rect.height]),
    ...context.pathFills.flatMap((fill) => fill.segments.flatMap((segment) => [segment.x1, segment.y1, segment.x2, segment.y2])),
  ];
}
