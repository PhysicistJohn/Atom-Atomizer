// Agent surface completeness (A20): programmatic cross-check of the four Atom
// wiring surfaces plus the renderer control-ID inventory and instruction text.
//
//   1. agentToolNames <-> concrete definitions/schemas/policies sent to the model
//   2. agentToolNames <-> the desktop executor's switch cases
//      (apps/desktop/src/renderer/agent-executor.ts, read from source at test
//      time; the switch itself is compile-bound by `const unreachable: never`)
//   3. every agentControlBindings pattern <-> at least one — in fact every
//      enumerable — data-agent-control ID that the renderer source can render
//      (apps/desktop/src/renderer/**/*.ts{,x}, read with fs at test time)
//   4. ATOM_AGENT_INSTRUCTIONS and every tool description mention only tool
//      names that actually exist in the closed set
//
// The test FAILS on any orphan in any direction, and pins the full tool-name,
// semantic-control-ID, binding-pattern, and concrete control-ID inventories so
// additions are always deliberate edits here.
//
// Control-ID extraction rules (each cites the renderer source it models):
//   R1  data-agent-control="literal"  and  data-agent-control={expr} string or
//       template literals (e.g. SpectrumPlot.tsx `onMarkerPlace ? 'spectrum.marker-place' : undefined`,
//       Sidebar.tsx `workspace.${item.id}`).
//   R2  controlId="literal" / controlId={`template`} props: ParameterRow.tsx
//       renders its controlId prop as data-agent-control (lines 117, 137, 238,
//       254, 268), so every controlId fed to the ParameterRow family is a
//       rendered agent control (AnalyzerInspector.tsx, MeasurementDock.tsx,
//       WaterfallView.tsx, ChannelAnalysisView.tsx, ClassificationWorkspace.tsx,
//       GeneratorWorkspace.tsx).
//   R3  ${controlPrefix} interpolations are substituted with every literal
//       controlPrefix="..." value found in renderer source: ReceiverControlRows.tsx
//       derives `${controlPrefix}.trigger`, `.trigger-level`, `.rbw`,
//       `.attenuation`, and AnalyzerInspector.tsx:52 instantiates
//       controlPrefix="analyzer".
//   R4  every controlId resolved at an <AutomaticNumericParameter .../> call
//       site additionally renders `${controlId}-mode`
//       (ReceiverControlRows.tsx:45). The internal `${controlId}-mode`
//       template itself is skipped as an unresolvable prop variable.
//   R5  any other interpolation becomes the wildcard [A-Za-z0-9-]+ (rendered
//       ID segments never contain dots).
//
// Two defense layers: the witness checks catch any pattern family with no
// source presence at all (e.g. the retired stft.* and classification.envelope*
// families), while the explicit pins below are the deliberate-edit gate for
// alternatives that an R5 wildcard template would otherwise vacuously witness
// (e.g. a re-added workspace.spectrum inside `workspace.${item.id}`).

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ATOM_AGENT_INSTRUCTIONS,
  ATOM_TOOL_LOADER_NAME,
  agentControlBinding,
  agentControlBindings,
  agentSemanticControlIds,
  agentToolDefinitions,
  agentToolInputSchemas,
  agentToolNames,
  agentToolPolicies,
} from './index.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const rendererDirectory = join(repoRoot, 'apps/desktop/src/renderer');
const executorPath = join(rendererDirectory, 'agent-executor.ts');

// ---------------------------------------------------------------------------
// Renderer source inventory
// ---------------------------------------------------------------------------

interface TemplateWitness {
  readonly source: string;
  readonly file: string;
  readonly regex: RegExp;
}

interface RendererControlInventory {
  readonly files: readonly string[];
  readonly literalIds: ReadonlyMap<string, string>; // id -> first file
  readonly templates: readonly TemplateWitness[];
}

function listRendererSources(): string[] {
  const entries = readdirSync(rendererDirectory, { recursive: true }) as string[];
  return entries
    .filter((entry) => /\.(ts|tsx)$/.test(entry))
    .filter((entry) => !/\.test\.tsx?$/.test(entry) && !entry.endsWith('.d.ts'))
    .filter((entry) => !entry.includes('node_modules') && !entry.includes('__snapshots__'))
    .map((entry) => join(rendererDirectory, entry))
    .sort();
}

function balancedExpression(text: string, openBraceIndex: number): string {
  let depth = 0;
  for (let index = openBraceIndex; index < text.length; index++) {
    if (text[index] === '{') depth++;
    else if (text[index] === '}') {
      depth--;
      if (depth === 0) return text.slice(openBraceIndex + 1, index);
    }
  }
  throw new Error(`Unbalanced JSX expression braces at index ${openBraceIndex}`);
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WILDCARD = '[A-Za-z0-9-]+';

/** Expand one template literal body into concrete IDs and/or wildcard regexes. */
function expandTemplate(
  template: string,
  file: string,
  prefixes: readonly string[],
  addLiteral: (id: string, file: string) => void,
  addTemplate: (witness: TemplateWitness) => void,
): void {
  // Segment the template into fixed text and interpolation expressions.
  const segments: { kind: 'fixed' | 'expression'; value: string }[] = [];
  let cursor = 0;
  while (cursor < template.length) {
    const start = template.indexOf('${', cursor);
    if (start === -1) {
      segments.push({ kind: 'fixed', value: template.slice(cursor) });
      break;
    }
    if (start > cursor) segments.push({ kind: 'fixed', value: template.slice(cursor, start) });
    let depth = 0;
    let end = -1;
    for (let index = start + 1; index < template.length; index++) {
      if (template[index] === '{') depth++;
      else if (template[index] === '}') {
        depth--;
        if (depth === 0) { end = index; break; }
      }
    }
    if (end === -1) throw new Error(`Unterminated interpolation in template \`${template}\` (${file})`);
    segments.push({ kind: 'expression', value: template.slice(start + 2, end).trim() });
    cursor = end + 1;
  }
  // R4: `${controlId}-mode` inside ReceiverControlRows.tsx is resolved at
  // AutomaticNumericParameter call sites instead of here.
  if (segments.some((segment) => segment.kind === 'expression' && segment.value === 'controlId')) return;

  // Each segment contributes one or more options; options are either concrete
  // strings or the wildcard marker.
  let options: { text: string; concrete: boolean }[] = [{ text: '', concrete: true }];
  const extend = (candidates: readonly { text: string; concrete: boolean }[]): void => {
    const next: { text: string; concrete: boolean }[] = [];
    for (const current of options) for (const candidate of candidates) {
      next.push({ text: current.text + candidate.text, concrete: current.concrete && candidate.concrete });
    }
    if (next.length > 4_096) throw new Error(`Template \`${template}\` expanded past the 4096 bound (${file})`);
    options = next;
  };
  for (const segment of segments) {
    if (segment.kind === 'fixed') {
      extend([{ text: escapeRegex(segment.value), concrete: true }]);
      continue;
    }
    const ternary = /^[^?]*\?\s*'([^']*)'\s*:\s*'([^']*)'\s*$/.exec(segment.value);
    if (ternary) {
      extend([
        { text: escapeRegex(ternary[1]!), concrete: true },
        { text: escapeRegex(ternary[2]!), concrete: true },
      ]);
      continue;
    }
    if (segment.value === 'controlPrefix') {
      if (!prefixes.length) throw new Error(`Template \`${template}\` uses controlPrefix but no controlPrefix="..." literal exists (${file})`);
      extend(prefixes.map((prefix) => ({ text: escapeRegex(prefix), concrete: true })));
      continue;
    }
    extend([{ text: WILDCARD, concrete: false }]); // R5
  }
  for (const option of options) {
    if (option.concrete) {
      // A fully concrete expansion is an exact rendered ID (regex-escape undone
      // by construction: concrete parts only ever pass through escapeRegex, so
      // unescape for the literal inventory).
      const literal = option.text.replace(/\\([.*+?^${}()|[\]\\])/g, '$1');
      if (literal.includes('.')) addLiteral(literal, file);
    } else {
      addTemplate({ source: `^${option.text}$`, file, regex: new RegExp(`^${option.text}$`) });
    }
  }
}

function extractRendererControlInventory(): RendererControlInventory {
  const files = listRendererSources();
  const sources = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));

  // R3: collect every literal controlPrefix instantiation first.
  const prefixes = new Set<string>();
  for (const text of sources.values()) {
    for (const match of text.matchAll(/controlPrefix="([^"]+)"/g)) prefixes.add(match[1]!);
  }

  const literalIds = new Map<string, string>();
  const templates: TemplateWitness[] = [];
  const addLiteral = (id: string, file: string): void => {
    if (!literalIds.has(id)) literalIds.set(id, file);
  };
  const addTemplate = (witness: TemplateWitness): void => {
    if (!templates.some((existing) => existing.source === witness.source)) templates.push(witness);
  };

  const harvestExpression = (expression: string, file: string): void => {
    for (const literal of expression.matchAll(/(?<!\$\{[^}]*)'([^'`]+)'/g)) {
      if (literal[1]!.includes('.')) addLiteral(literal[1]!, file);
    }
    for (const template of expression.matchAll(/`([^`]*)`/g)) {
      expandTemplate(template[1]!, file, [...prefixes], addLiteral, addTemplate);
    }
  };

  for (const [file, text] of sources) {
    // R1 + R2 literal attributes/props.
    for (const match of text.matchAll(/(?:data-agent-control|(?<![A-Za-z0-9_-])controlId)="([^"]+)"/g)) addLiteral(match[1]!, file);
    // R1 + R2 expression attributes/props.
    for (const match of text.matchAll(/(?:data-agent-control|(?<![A-Za-z0-9_-])controlId)=\{/g)) {
      harvestExpression(balancedExpression(text, match.index! + match[0].length - 1), file);
    }
    // R4: -mode derivation at AutomaticNumericParameter call sites.
    for (const element of text.matchAll(/<AutomaticNumericParameter\b[\s\S]*?\/>/g)) {
      const chunk = element[0];
      const literal = /(?<![A-Za-z0-9_-])controlId="([^"]+)"/.exec(chunk);
      const resolved: string[] = [];
      if (literal) resolved.push(literal[1]!);
      const template = /(?<![A-Za-z0-9_-])controlId=\{`([^`]*)`\}/.exec(chunk);
      if (template) {
        expandTemplate(template[1]!, file, [...prefixes], (id) => resolved.push(id), () => {
          throw new Error(`AutomaticNumericParameter controlId template in ${file} did not resolve to concrete IDs`);
        });
      }
      for (const id of resolved) addLiteral(`${id}-mode`, file);
    }
  }
  return { files, literalIds, templates };
}

// ---------------------------------------------------------------------------
// Bounded expansion of the authored binding-pattern regex dialect
// ---------------------------------------------------------------------------

/** Expand a binding pattern into every candidate ID, sampling one
 * representative character per character class (classes only ever stand for
 * opaque instance segments such as marker numbers or candidate IDs). */
function expandBindingPattern(source: string): string[] {
  const body = source.replace(/^\^/, '').replace(/\$$/, '');
  const [expansions, consumed] = expandSequence(body, 0, source);
  if (consumed !== body.length) throw new Error(`Binding pattern ${source} has trailing unsupported syntax at ${consumed}`);
  if (!expansions.length) throw new Error(`Binding pattern ${source} expanded to nothing`);
  return expansions;
}

function expandSequence(body: string, start: number, source: string): [string[], number] {
  let expansions = [''];
  let index = start;
  const append = (candidates: readonly string[]): void => {
    const next: string[] = [];
    for (const current of expansions) for (const candidate of candidates) next.push(current + candidate);
    if (next.length > 4_096) throw new Error(`Binding pattern ${source} expanded past the 4096 bound`);
    expansions = next;
  };
  while (index < body.length) {
    const character = body[index]!;
    if (character === ')' || character === '|') break;
    if (character === '\\') {
      append([body[index + 1]!]);
      index += 2;
      continue;
    }
    if (character === '(') {
      const alternatives: string[] = [];
      let cursor = index + 1;
      while (true) {
        const [branch, next] = expandSequence(body, cursor, source);
        alternatives.push(...branch);
        if (body[next] === '|') { cursor = next + 1; continue; }
        if (body[next] === ')') { cursor = next + 1; break; }
        throw new Error(`Binding pattern ${source} has an unterminated group`);
      }
      if (body[cursor] === '?') {
        append(['', ...alternatives]);
        cursor++;
      } else append(alternatives);
      index = cursor;
      continue;
    }
    if (character === '[') {
      const end = body.indexOf(']', index);
      if (end === -1) throw new Error(`Binding pattern ${source} has an unterminated class`);
      const representative = body[index + 1]!; // first member (range start included)
      index = end + 1;
      if (body[index] === '*') { append(['']); index++; }
      else if (body[index] === '{') {
        const close = body.indexOf('}', index);
        const minimum = Number(/^\{(\d+)/.exec(body.slice(index))?.[1] ?? '1');
        append([representative.repeat(Math.max(1, minimum))]);
        index = close + 1;
      } else append([representative]);
      continue;
    }
    if (/[A-Za-z0-9-]/.test(character)) {
      append([character]);
      index++;
      continue;
    }
    throw new Error(`Binding pattern ${source} uses unsupported syntax '${character}' at ${index}`);
  }
  return [expansions, index];
}

// ---------------------------------------------------------------------------
// A20 pins — additions to any surface must be deliberate edits here.
// ---------------------------------------------------------------------------

const EXPECTED_TOOL_NAMES = [
  'get_application_state', 'get_system_topology', 'get_agent_surface', 'get_instrument_state', 'get_latest_sweep_summary',
  'get_detection_results', 'get_classification_results', 'read_device_diagnostics',
  'list_connection_candidates', 'connect_device', 'disconnect_device',
  'inspect_interface', 'computer_action',
  'computer_screenshot', 'computer_click', 'computer_type', 'computer_key', 'computer_scroll',
  'navigate_workspace', 'configure_analyzer', 'acquire_sweep',
  'start_continuous_sweeps', 'stop_continuous_sweeps',
  'get_measurement_state', 'select_marker', 'configure_marker', 'configure_marker_search', 'search_marker', 'select_trace', 'configure_trace', 'configure_firmware_trace_visibility', 'reset_trace', 'configure_spectrum_display', 'auto_scale_spectrum_display',
  'set_measurement_view', 'configure_waterfall', 'configure_channel_measurement', 'get_channel_measurement_results',
  'configure_envelope_stft', 'get_envelope_stft_results', 'acquire_envelope_stft',
  'configure_signal_detector', 'configure_zero_span', 'acquire_zero_span',
  'configure_generator', 'set_rf_output', 'select_signal_lab_profile',
  'capture_device_screen', 'remote_device_touch', 'export_latest_sweep',
] as const;

const EXPECTED_SEMANTIC_CONTROL_IDS = [
  'workspace.classification', 'workspace.iq', 'workspace.generator', 'workspace.device',
  'measurement.view.spectrum', 'measurement.view.waterfall', 'measurement.view.channel',
  'measurement.setup', 'measurement.controls', 'measurement.markers', 'measurement.traces', 'measurement.display',
  'spectrum.marker-place',
  'acquisition.single', 'acquisition.continuous.start', 'acquisition.continuous.stop',
  'marker.search.peak', 'marker.search.minimum', 'marker.search.left', 'marker.search.right',
  'display.auto-scale', 'classification.capture-envelope', 'generator.apply',
  'analyzer.preset.fm', 'analyzer.preset.2g4', 'analyzer.preset.5g', 'analyzer.advanced',
  'connection.open', 'connection.close', 'connection.refresh', 'connection.disconnect', 'connection.retry-cleanup',
  'device.capture-screen', 'device.refresh-diagnostics', 'device.remote-touch', 'generator.rf-output', 'atom.toggle', 'atom.approve-high-impact',
  'export.csv', 'export.json', 'error.dismiss', 'notice.dismiss', 'atom.close',
  'atom.microphone-mute', 'atom.speaker-mute',
] as const;

const EXPECTED_BINDING_PATTERNS = [
  '^workspace\\.(classification|iq|generator|device)$',
  '^measurement\\.view\\.(spectrum|waterfall|channel)$',
  '^measurement\\.(setup|controls|markers|traces|display)$',
  '^spectrum\\.marker-place$',
  '^acquisition\\.single$',
  '^acquisition\\.continuous\\.start$',
  '^acquisition\\.continuous\\.stop$',
  '^analyzer\\.(start|stop|center|span|points|rbw(-mode)?|transfer|attenuation(-mode)?|sweep-time(-mode)?|detector|spur-rejection|avoid-spurs|lna|trigger|trigger-level)$',
  '^analyzer\\.preset\\.(fm|2g4|5g)$',
  '^analyzer\\.advanced$',
  '^detection\\.(threshold-mode|margin|absolute-level|prominence|minimum-bandwidth|promote|release)$',
  '^classification\\.capture-envelope$',
  '^waterfall\\.(floor|ceiling|depth)$',
  '^channel\\.(center|main-bandwidth|spacing|adjacent-bandwidth|adjacent-count|occupied-power|obw-noise)$',
  '^marker\\.[1-8]\\.select$',
  '^marker\\.[1-8]\\.(enabled|frequency|trace|readout|reference|peak-track)$',
  '^marker\\.search\\.(threshold|excursion)$',
  '^marker\\.search\\.(peak|minimum|left|right)$',
  '^trace\\.[1-4]\\.select$',
  '^trace\\.[1-4]\\.(enabled|mode|average-count)$',
  '^firmware-trace\\.[1-4]\\.visible$',
  '^trace\\.[1-4]\\.reset$',
  '^display\\.(reference-level|scale)$',
  '^display\\.auto-scale$',
  '^generator\\.(frequency|level|path|modulation|modulation-rate|am-depth|fm-deviation|apply)$',
  '^generator\\.rf-output$',
  '^device\\.capture-screen$',
  '^device\\.refresh-diagnostics$',
  '^device\\.remote-touch$',
  '^connection\\.open$',
  '^connection\\.close$',
  '^connection\\.refresh$',
  '^connection\\.candidate\\.[1-9][0-9]*\\.select$',
  '^connection\\.disconnect$',
  '^connection\\.retry-cleanup$',
  '^export\\.(csv|json)$',
  '^(error|notice)\\.dismiss$',
  '^atom\\.close$',
  '^atom\\.toggle$',
  '^atom\\.(microphone|speaker)-mute$',
  '^atom\\.approve-high-impact$',
] as const;

const EXPECTED_CONCRETE_CONTROL_IDS = [
  'acquisition.continuous.start', 'acquisition.continuous.stop', 'acquisition.single',
  'analyzer.advanced', 'analyzer.attenuation', 'analyzer.attenuation-mode', 'analyzer.avoid-spurs',
  'analyzer.center', 'analyzer.detector', 'analyzer.lna', 'analyzer.points', 'analyzer.preset.2g4', 'analyzer.preset.5g',
  'analyzer.preset.fm', 'analyzer.rbw', 'analyzer.rbw-mode', 'analyzer.span', 'analyzer.spur-rejection', 'analyzer.start',
  'analyzer.stop', 'analyzer.sweep-time', 'analyzer.sweep-time-mode', 'analyzer.transfer',
  'analyzer.trigger', 'analyzer.trigger-level',
  'atom.approve-high-impact', 'atom.close', 'atom.microphone-mute', 'atom.speaker-mute', 'atom.toggle',
  'channel.adjacent-bandwidth', 'channel.adjacent-count', 'channel.center', 'channel.main-bandwidth',
  'channel.obw-noise', 'channel.occupied-power', 'channel.spacing',
  'classification.capture-envelope',
  'connection.close', 'connection.disconnect',
  'connection.open', 'connection.refresh', 'connection.retry-cleanup',
  'detection.absolute-level', 'detection.margin', 'detection.minimum-bandwidth', 'detection.prominence',
  'detection.promote', 'detection.release', 'detection.threshold-mode',
  'device.capture-screen', 'device.refresh-diagnostics', 'device.remote-touch',
  'display.auto-scale', 'display.reference-level', 'display.scale',
  'error.dismiss', 'export.csv', 'export.json',
  'generator.am-depth', 'generator.apply', 'generator.fm-deviation', 'generator.frequency',
  'generator.level', 'generator.modulation', 'generator.modulation-rate', 'generator.path', 'generator.rf-output',
  'marker.search.excursion', 'marker.search.left', 'marker.search.minimum', 'marker.search.peak',
  'marker.search.right', 'marker.search.threshold', 'measurement.controls', 'measurement.display', 'measurement.markers',
  'measurement.setup', 'measurement.traces', 'notice.dismiss', 'spectrum.marker-place',
  'waterfall.ceiling', 'waterfall.depth', 'waterfall.floor',
] as const;

const EXPECTED_TEMPLATE_WITNESSES = [
  '^connection\\.candidate\\.[A-Za-z0-9-]+\\.select$',
  '^firmware-trace\\.[A-Za-z0-9-]+\\.visible$',
  '^marker\\.[A-Za-z0-9-]+\\.enabled$',
  '^marker\\.[A-Za-z0-9-]+\\.frequency$',
  '^marker\\.[A-Za-z0-9-]+\\.peak-track$',
  '^marker\\.[A-Za-z0-9-]+\\.readout$',
  '^marker\\.[A-Za-z0-9-]+\\.reference$',
  '^marker\\.[A-Za-z0-9-]+\\.select$',
  '^marker\\.[A-Za-z0-9-]+\\.trace$',
  '^measurement\\.view\\.[A-Za-z0-9-]+$',
  '^trace\\.[A-Za-z0-9-]+\\.average-count$',
  '^trace\\.[A-Za-z0-9-]+\\.enabled$',
  '^trace\\.[A-Za-z0-9-]+\\.mode$',
  '^trace\\.[A-Za-z0-9-]+\\.reset$',
  '^trace\\.[A-Za-z0-9-]+\\.select$',
  '^workspace\\.[A-Za-z0-9-]+$',
] as const;

// ---------------------------------------------------------------------------

describe('Atom agent surface completeness (A20)', () => {
  const inventory = extractRendererControlInventory();
  const witnessed = (id: string): boolean =>
    inventory.literalIds.has(id) || inventory.templates.some((template) => template.regex.test(id));

  it('pins the closed tool-name list so additions are deliberate', () => {
    expect([...agentToolNames]).toEqual([...EXPECTED_TOOL_NAMES]);
  });

  it('sends the model exactly one definition, schema, and policy per tool name', () => {
    expect(agentToolDefinitions.map((tool) => tool.name).sort()).toEqual([...agentToolNames].sort());
    expect(new Set(agentToolDefinitions.map((tool) => tool.name)).size).toBe(agentToolNames.length);
    expect(Object.keys(agentToolInputSchemas).sort()).toEqual([...agentToolNames].sort());
    expect(Object.keys(agentToolPolicies).sort()).toEqual([...agentToolNames].sort());
  });

  it('gives every tool name exactly one executor case and every case a tool name', () => {
    const executorSource = readFileSync(executorPath, 'utf8');
    expect(executorSource, `${executorPath} must keep its compile-time exhaustiveness marker`)
      .toContain('const unreachable: never = name');
    const switchStart = executorSource.indexOf('switch (name)');
    const switchEnd = executorSource.indexOf('const unreachable: never = name');
    expect(switchStart, 'executeAgentTool switch present').toBeGreaterThan(-1);
    expect(switchEnd).toBeGreaterThan(switchStart);
    const cases = [...executorSource.slice(switchStart, switchEnd).matchAll(/case '([a-z0-9_]+)'/g)].map((match) => match[1]!);
    expect(new Set(cases).size, 'no duplicate executor cases').toBe(cases.length);
    expect([...cases].sort()).toEqual([...agentToolNames].sort());
  });

  it('pins the semantic control IDs and binds each exactly once to a rendered witness', () => {
    expect([...agentSemanticControlIds]).toEqual([...EXPECTED_SEMANTIC_CONTROL_IDS]);
    for (const controlId of agentSemanticControlIds) {
      expect(() => agentControlBinding(controlId), controlId).not.toThrow();
      expect(witnessed(controlId), `${controlId} must be renderable from renderer source`).toBe(true);
    }
  });

  it('pins the binding patterns and proves every pattern alternative renderable from source', () => {
    expect(agentControlBindings.map((binding) => binding.pattern.source)).toEqual([...EXPECTED_BINDING_PATTERNS]);
    expect(inventory.files.length).toBeGreaterThan(20);
    for (const binding of agentControlBindings) {
      const candidates = expandBindingPattern(binding.pattern.source);
      for (const candidate of candidates) {
        expect(
          witnessed(candidate),
          `${binding.pattern.source} alternative ${candidate} matches no data-agent-control the renderer can render`,
        ).toBe(true);
      }
    }
  });

  it('maps every source-extracted control ID and template family to exactly one binding', () => {
    for (const [controlId, file] of inventory.literalIds) {
      expect(() => agentControlBinding(controlId), `${controlId} (${file})`).not.toThrow();
    }
    const allCandidates = agentControlBindings.flatMap((binding) => expandBindingPattern(binding.pattern.source));
    for (const template of inventory.templates) {
      expect(
        allCandidates.some((candidate) => template.regex.test(candidate)),
        `template ${template.source} (${template.file}) intersects no binding pattern`,
      ).toBe(true);
    }
  });

  it('pins the concrete control-ID and template inventories extracted from renderer source', () => {
    expect([...inventory.literalIds.keys()].sort()).toEqual([...EXPECTED_CONCRETE_CONTROL_IDS]);
    expect(inventory.templates.map((template) => template.source).sort()).toEqual([...EXPECTED_TEMPLATE_WITNESSES]);
  });

  it('mentions only real tool names throughout the instructions and tool descriptions', () => {
    const validNames = new Set<string>([...agentToolNames, ATOM_TOOL_LOADER_NAME]);
    const scan = (text: string, where: string): void => {
      for (const match of text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) {
        expect(validNames.has(match[0]), `${where} mentions unknown tool-like name ${match[0]}`).toBe(true);
      }
    };
    scan(ATOM_AGENT_INSTRUCTIONS, 'ATOM_AGENT_INSTRUCTIONS');
    for (const tool of agentToolDefinitions) {
      scan(tool.description, `${tool.name} description`);
      scan(JSON.stringify(tool.parameters), `${tool.name} parameter schema`);
    }
  });
});
