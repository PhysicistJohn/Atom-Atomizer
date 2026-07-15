import { readFile, readdir } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

const repositoryRoot = resolve(process.env.TINYSA_BOUNDARY_ROOT ?? '.');
const fromRoot = (path) => resolve(repositoryRoot, path);
const rootPackage = await readJson(fromRoot('package.json'));
const workspacePackages = await discoverWorkspacePackages(rootPackage.workspaces);
const packageByName = new Map(workspacePackages.map((item) => [item.manifest.name, item]));
const nodeBuiltinModules = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));

if (packageByName.size !== workspacePackages.length) {
  throw new Error('Workspace contains duplicate or missing package names');
}
assertWorkspaceGraphIsAcyclic(workspacePackages, packageByName);

const runtime = requireWorkspacePackage('@tinysa/instrument-runtime');
const signalLabDriver = requireWorkspacePackage('@tinysa/signal-lab-driver');
const device = requireWorkspacePackage('@tinysa/device');
const desktop = requireWorkspacePackage('@tinysa/desktop');
assertExactKeys(
  runtime.manifest.dependencies,
  ['@tinysa/contracts', 'zod'],
  '@tinysa/instrument-runtime production dependency whitelist',
);
for (const section of ['peerDependencies', 'optionalDependencies']) {
  assertExactKeys(runtime.manifest[section], [], `@tinysa/instrument-runtime ${section} whitelist`);
}
if (runtime.manifest.devDependencies !== undefined) {
  throw new Error('@tinysa/instrument-runtime must inherit test tooling from the root instead of adding package-local devDependencies');
}

const runtimeSources = await readProductionSources(runtime.directory);
assertProductionImportsDeclared(runtimeSources, runtime.manifest);
for (const forbidden of ['@tinysa/device', '@tinysa/signal-lab-driver', 'serialport', 'electron']) {
  assertNoBareImport(runtimeSources, forbidden, '@tinysa/instrument-runtime');
}

assertExactKeys(
  signalLabDriver.manifest.dependencies,
  ['@tinysa/contracts', '@tinysa/instrument-runtime'],
  '@tinysa/signal-lab-driver production dependency whitelist',
);
for (const section of ['peerDependencies', 'optionalDependencies', 'devDependencies']) {
  assertExactKeys(signalLabDriver.manifest[section], [], `@tinysa/signal-lab-driver ${section} whitelist`);
}
const signalLabSources = await readProductionSources(signalLabDriver.directory);
assertProductionImportsDeclared(signalLabSources, signalLabDriver.manifest);
for (const forbidden of ['@tinysa/device', 'serialport', 'electron']) {
  assertNoBareImport(signalLabSources, forbidden, '@tinysa/signal-lab-driver');
}

assertExactKeys(
  device.manifest.dependencies,
  ['@tinysa/contracts', '@tinysa/instrument-runtime', 'serialport'],
  '@tinysa/device production dependency whitelist',
);
for (const section of ['peerDependencies', 'optionalDependencies']) {
  assertExactKeys(device.manifest[section], [], `@tinysa/device ${section} whitelist`);
}
if (desktop.manifest.dependencies?.['@tinysa/instrument-runtime'] === undefined) {
  throw new Error('@tinysa/desktop must depend directly on @tinysa/instrument-runtime');
}
if (desktop.manifest.dependencies?.['@tinysa/signal-lab-driver'] === undefined) {
  throw new Error('@tinysa/desktop must depend directly on @tinysa/signal-lab-driver');
}
if (device.manifest.dependencies?.['@tinysa/signal-lab-driver'] !== undefined) {
  throw new Error('@tinysa/device must not depend on the independent SignalLab driver package');
}
const deviceSources = await readProductionSources(device.directory);
assertProductionImportsDeclared(deviceSources, device.manifest);
assertNoBareImport(deviceSources, '@tinysa/signal-lab-driver', '@tinysa/device');
assertNoBareImport(deviceSources, 'electron', '@tinysa/device');
assertOnlyTypeImportsFrom(deviceSources, '@tinysa/instrument-runtime', '@tinysa/device');
assertImportedTypeNamesWhitelisted(
  deviceSources,
  '@tinysa/instrument-runtime',
  ['InstrumentDriver', 'InstrumentSession'],
  '@tinysa/device',
);
assertNoImportedBindingsReExported(deviceSources, '@tinysa/instrument-runtime', '@tinysa/device');
assertNoBareReExport(deviceSources, '@tinysa/instrument-runtime', '@tinysa/device');
for (const removedCompatibilityModule of [
  'src/instrument-driver.ts',
  'src/instrument-manager.ts',
  'src/instrument-driver-registry.ts',
  'src/measurement-fingerprint.ts',
]) {
  if (deviceSources.some((source) => source.path === removedCompatibilityModule)) {
    throw new Error(`@tinysa/device retains removed generic-runtime compatibility module ${removedCompatibilityModule}`);
  }
}
const desktopSources = await readProductionSources(desktop.directory);
const desktopPrivilegedSources = desktopSources.filter((source) => source.path.startsWith('src/main/'));
const desktopRendererSources = desktopSources.filter((source) => source.path.startsWith('src/renderer/'));
const desktopPreloadSources = desktopSources.filter((source) => source.path === 'src/main/preload.ts');
assertNoBareImport(desktopRendererSources, 'electron', '@tinysa/desktop renderer');
assertNoNodeBuiltinImport(desktopRendererSources, '@tinysa/desktop renderer');
assertNoNodeBuiltinImport(desktopPreloadSources, '@tinysa/desktop preload');
assertRuntimeBareImportsWhitelisted(
  desktopPreloadSources,
  ['electron'],
  '@tinysa/desktop preload',
);
for (const privilegedPackage of [
  '@tinysa/device',
  '@tinysa/instrument-runtime',
  '@tinysa/signal-lab-driver',
]) {
  assertNoBareImport(desktopRendererSources, privilegedPackage, '@tinysa/desktop renderer');
}
assertBareImportOnlyInPaths(
  desktopPrivilegedSources,
  '@tinysa/device',
  ['src/main/main.ts'],
  '@tinysa/desktop TinySA adapter ownership',
);
assertBareImportOnlyInPaths(
  desktopPrivilegedSources,
  '@tinysa/instrument-runtime',
  ['src/main/main.ts', 'src/main/atomizer-instrument-host.ts'],
  '@tinysa/desktop lifecycle ownership',
);
assertBareImportOnlyInPaths(
  desktopPrivilegedSources,
  '@tinysa/signal-lab-driver',
  ['src/main/main.ts', 'src/main/instrument-preference.ts'],
  '@tinysa/desktop SignalLab adapter ownership',
);
assertProductionImportsDeclared(
  desktopPrivilegedSources,
  desktop.manifest,
  ['electron'],
  [{ path: 'src/main/development-renderer-csp-vite.ts', packageName: 'vite' }],
);
assertProductionImportsDeclared(desktopRendererSources, desktop.manifest);
for (const source of desktopSources) {
  for (const imported of staticImports(source.text)) {
    if (imported.specifier === '@tinysa/device'
      && /\b(?:InstrumentManager|InstrumentDriverRegistry|InstrumentDriverContractError|fingerprintInstrumentMeasurement)\b/.test(imported.clause)) {
      throw new Error(`${source.path} imports generic runtime ownership from the device compatibility facade`);
    }
    if (imported.specifier === '@tinysa/device' && /\bSignalLab\w*\b/.test(imported.clause)) {
      throw new Error(`${source.path} imports SignalLab adapter ownership from the TinySA device package`);
    }
  }
}
requireImportBinding(
  desktopSources,
  'src/main/main.ts',
  '@tinysa/instrument-runtime',
  /\bInstrumentDriverRegistry\b/,
  'desktop lifecycle registry ownership',
);
requireImportBinding(
  desktopSources,
  'src/main/main.ts',
  '@tinysa/signal-lab-driver',
  /\bSignalLabInstrumentDriver\b/,
  'desktop SignalLab adapter ownership',
);
requireImportBinding(
  desktopSources,
  'src/main/main.ts',
  '@tinysa/instrument-runtime',
  /\bInstrumentManager\b/,
  'desktop lifecycle manager ownership',
);
requireImportBinding(
  desktopSources,
  'src/main/atomizer-instrument-host.ts',
  '@tinysa/instrument-runtime',
  /\bfingerprintInstrumentMeasurement\b/,
  'desktop host fingerprint ownership',
);

const deviceJavascriptPath = fromRoot('packages/tinysa/dist/index.js');
const deviceDeclarationsPath = fromRoot('packages/tinysa/dist/index.d.ts');
const launcherPath = fromRoot('tools/dev-launcher/main.cjs');
const runtimeJavascriptPath = fromRoot('packages/instrument-runtime/dist/index.js');
const runtimeDeclarationsPath = fromRoot('packages/instrument-runtime/dist/index.d.ts');
const signalLabJavascriptPath = fromRoot('packages/signal-lab-driver/dist/index.js');
const signalLabDeclarationsPath = fromRoot('packages/signal-lab-driver/dist/index.d.ts');
const [deviceJavascript, deviceDeclarations, launcher, runtimeJavascript, runtimeDeclarations, signalLabJavascript, signalLabDeclarations] = await Promise.all([
  readFile(deviceJavascriptPath, 'utf8'),
  readFile(deviceDeclarationsPath, 'utf8'),
  readFile(launcherPath, 'utf8'),
  readFile(runtimeJavascriptPath, 'utf8'),
  readFile(runtimeDeclarationsPath, 'utf8'),
  readFile(signalLabJavascriptPath, 'utf8'),
  readFile(signalLabDeclarationsPath, 'utf8'),
]);

rejectText(deviceJavascript, 'export * from "@tinysa/instrument-runtime";', 'device JavaScript generic-runtime re-export');
rejectText(deviceDeclarations, "export * from '@tinysa/instrument-runtime';", 'device declaration generic-runtime re-export');
rejectText(deviceJavascript, '@tinysa/instrument-runtime', 'device JavaScript generic-runtime value reference');
assertNoBareImport(
  [{ path: relative(device.directory, deviceJavascriptPath).replaceAll('\\', '/'), text: deviceJavascript }],
  'electron',
  '@tinysa/device artifact',
);
requireText(device.manifest.scripts?.build, '--external @tinysa/instrument-runtime', 'device package external build boundary');
requireText(signalLabDriver.manifest.scripts?.build, '--external @tinysa/instrument-runtime', 'SignalLab package external build boundary');
requireText(signalLabJavascript, 'from "@tinysa/instrument-runtime"', 'SignalLab artifact external runtime import');
requireText(launcher, "['tinysa', ['--external', 'serialport', '--external', '@tinysa/instrument-runtime']]", 'development launcher external build boundary');
requireText(launcher, "['signal-lab-driver', ['--external', '@tinysa/instrument-runtime']]", 'SignalLab development launcher build boundary');

for (const [label, expression] of [
  ['InstrumentManager implementation', /class InstrumentManager\b/],
  ['InstrumentDriverContractError implementation', /class InstrumentDriverContractError\b/],
  ['measurement fingerprint implementation', /function fingerprintInstrumentMeasurement\b/],
  ['SignalLab driver implementation', /class SignalLabInstrumentDriver\b/],
]) {
  if (expression.test(deviceJavascript)) {
    throw new Error(`@tinysa/device dist illegally bundles the separated ${label}`);
  }
}
for (const forbidden of ['@tinysa/device', '@tinysa/signal-lab-driver', 'serialport', 'electron']) {
  if (runtimeJavascript.includes(forbidden) || runtimeDeclarations.includes(forbidden)) {
    throw new Error(`@tinysa/instrument-runtime dist or declarations illegally reference ${forbidden}`);
  }
}
for (const [label, expression] of [
  ['InstrumentManager implementation', /class InstrumentManager\b/],
  ['InstrumentDriverContractError implementation', /class InstrumentDriverContractError\b/],
  ['measurement parser implementation', /function parseInstrumentMeasurement\b/],
  ['measurement fingerprint implementation', /function fingerprintInstrumentMeasurement\b/],
]) {
  if (expression.test(signalLabJavascript)) {
    throw new Error(`@tinysa/signal-lab-driver dist illegally bundles the generic-runtime ${label}`);
  }
}
for (const forbidden of ['@tinysa/device', 'serialport', 'electron']) {
  if (signalLabJavascript.includes(forbidden) || signalLabDeclarations.includes(forbidden)) {
    throw new Error(`@tinysa/signal-lab-driver dist or declarations illegally reference ${forbidden}`);
  }
}

console.log(JSON.stringify({
  status: 'passed',
  workspacePackages: workspacePackages.length,
  workspaceProductionDependencyGraph: 'acyclic',
  genericRuntimeDependencies: Object.keys(runtime.manifest.dependencies).sort(),
  deviceArtifact: relative(repositoryRoot, deviceJavascriptPath),
  genericRuntime: 'external-singleton',
  signalLabDriver: 'independent-no-serialport',
  reverseBoundary: 'source-and-manifest-enforced',
  desktopLifecycleOwnership: 'direct-runtime-imports',
  adapterOnlyPublicSurface: true,
}, null, 2));

async function discoverWorkspacePackages(patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0
    || patterns.some((pattern) => typeof pattern !== 'string' || !pattern.endsWith('/*'))) {
    throw new Error('Root workspaces must be non-empty single-directory wildcard patterns');
  }
  const packages = [];
  for (const pattern of patterns) {
    const parent = fromRoot(pattern.slice(0, -2));
    const entries = await readdir(parent, { withFileTypes: true });
    for (const entry of entries.filter((item) => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
      const directory = resolve(parent, entry.name);
      try {
        const manifest = await readJson(resolve(directory, 'package.json'));
        packages.push({ directory, manifest });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
  return packages;
}

function assertWorkspaceGraphIsAcyclic(packages, byName) {
  const graph = new Map(packages.map(({ manifest }) => [
    manifest.name,
    [...new Set(productionDependencyNames(manifest).filter((name) => byName.has(name)))].sort(),
  ]));
  const complete = new Set();
  const active = new Set();
  const stack = [];
  const visit = (name) => {
    if (complete.has(name)) return;
    if (active.has(name)) {
      const cycleStart = stack.indexOf(name);
      throw new Error(`Workspace dependency cycle: ${[...stack.slice(cycleStart), name].join(' -> ')}`);
    }
    active.add(name);
    stack.push(name);
    for (const dependency of graph.get(name) ?? []) visit(dependency);
    stack.pop();
    active.delete(name);
    complete.add(name);
  };
  for (const name of [...graph.keys()].sort()) visit(name);
}

function productionDependencyNames(manifest) {
  return ['dependencies', 'optionalDependencies']
    .flatMap((section) => Object.keys(manifest[section] ?? {}));
}

function productionImportDependencyNames(manifest) {
  return ['dependencies', 'peerDependencies', 'optionalDependencies']
    .flatMap((section) => Object.keys(manifest[section] ?? {}));
}

async function readProductionSources(packageDirectory) {
  const sourceRoot = resolve(packageDirectory, 'src');
  const paths = await recursiveFiles(sourceRoot);
  return Promise.all(paths
    .filter((path) => /\.[cm]?[jt]sx?$/.test(path) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path))
    .map(async (path) => ({
      path: relative(packageDirectory, path).replaceAll('\\', '/'),
      text: await readFile(path, 'utf8'),
    })));
}

async function recursiveFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const values = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) values.push(...await recursiveFiles(path));
    else if (entry.isFile()) values.push(path);
  }
  return values;
}

function assertProductionImportsDeclared(sources, manifest, platformProvided = [], typeOnlyExceptions = []) {
  const declared = new Set([
    ...productionImportDependencyNames(manifest),
    ...platformProvided,
  ]);
  for (const source of sources) {
    for (const imported of staticImports(source.text)) {
      if (typeof imported.specifier !== 'string') {
        throw new Error(`${source.path} contains a non-literal dynamic import or require dependency`);
      }
      if (imported.typeOnly && typeOnlyExceptions.some((exception) => exception.path === source.path
        && exception.packageName === packageNameFor(imported.specifier))) continue;
      if (imported.specifier.startsWith('.') || imported.specifier.startsWith('node:')) continue;
      const packageName = packageNameFor(imported.specifier);
      if (!declared.has(packageName)) {
        throw new Error(`${source.path} imports undeclared production package ${packageName}`);
      }
    }
  }
}

function packageNameFor(specifier) {
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
}

function assertNoBareImport(sources, packageName, label) {
  for (const source of sources) {
    if (staticImports(source.text).some(({ specifier }) => typeof specifier === 'string'
      && (specifier === packageName || specifier.startsWith(`${packageName}/`)))) {
      throw new Error(`${label} source ${source.path} illegally imports ${packageName}`);
    }
  }
}

function assertBareImportOnlyInPaths(sources, packageName, allowedPaths, label) {
  const allowed = new Set(allowedPaths);
  for (const source of sources) {
    if (allowed.has(source.path)) continue;
    if (staticImports(source.text).some(({ specifier }) => typeof specifier === 'string'
      && matchesPackage(specifier, packageName))) {
      throw new Error(`${label} source ${source.path} illegally imports ${packageName}`);
    }
  }
}

function assertNoNodeBuiltinImport(sources, label) {
  for (const source of sources) {
    const importedBuiltin = staticImports(source.text).find(({ specifier }) => {
      if (typeof specifier !== 'string') return false;
      const normalized = specifier.replace(/^node:/, '');
      return nodeBuiltinModules.has(normalized) || nodeBuiltinModules.has(normalized.split('/')[0]);
    });
    if (importedBuiltin) {
      throw new Error(`${label} source ${source.path} illegally imports Node built-in ${importedBuiltin.specifier}`);
    }
  }
}

function assertRuntimeBareImportsWhitelisted(sources, admittedSpecifiers, label) {
  const admitted = new Set(admittedSpecifiers);
  for (const source of sources) {
    for (const imported of staticImports(source.text)) {
      if (imported.typeOnly || typeof imported.specifier !== 'string'
        || imported.specifier.startsWith('.')) continue;
      if (!admitted.has(imported.specifier)) {
        throw new Error(`${label} source ${source.path} illegally imports runtime module ${imported.specifier}`);
      }
    }
  }
}

function assertNoBareReExport(sources, packageName, label) {
  for (const source of sources) {
    if (staticImports(source.text).some(({ kind, specifier }) => kind === 'export'
      && typeof specifier === 'string'
      && (specifier === packageName || specifier.startsWith(`${packageName}/`)))) {
      throw new Error(`${label} source ${source.path} must not re-export ${packageName}`);
    }
  }
}

function assertOnlyTypeImportsFrom(sources, packageName, label) {
  for (const source of sources) {
    if (staticImports(source.text).some(({ kind, specifier, typeOnly }) => kind !== 'export'
      && !typeOnly
      && typeof specifier === 'string'
      && (specifier === packageName || specifier.startsWith(`${packageName}/`)))) {
      throw new Error(`${label} source ${source.path} may reference ${packageName} only through erased type imports`);
    }
  }
}

function assertImportedTypeNamesWhitelisted(sources, packageName, admittedNames, label) {
  const admitted = new Set(admittedNames);
  for (const source of sources) {
    const parsed = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    for (const statement of parsed.statements) {
      if (!ts.isImportDeclaration(statement)
        || !ts.isStringLiteral(statement.moduleSpecifier)
        || !matchesPackage(statement.moduleSpecifier.text, packageName)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)
        || bindings.elements.some((element) => !admitted.has((element.propertyName ?? element.name).text))) {
        throw new Error(`${label} source ${source.path} imports a non-interface compatibility binding from ${packageName}`);
      }
    }
  }
}

function assertNoImportedBindingsReExported(sources, packageName, label) {
  for (const source of sources) {
    const parsed = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const importedLocals = new Set();
    for (const statement of parsed.statements) {
      if (!ts.isImportDeclaration(statement)
        || !ts.isStringLiteral(statement.moduleSpecifier)
        || !matchesPackage(statement.moduleSpecifier.text, packageName)) continue;
      const clause = statement.importClause;
      if (clause?.name) importedLocals.add(clause.name.text);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        importedLocals.add(clause.namedBindings.name.text);
      } else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) importedLocals.add(element.name.text);
      }
    }
    for (const statement of parsed.statements) {
      if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier
        && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const localName = (element.propertyName ?? element.name).text;
          if (importedLocals.has(localName)) {
            throw new Error(`${label} source ${source.path} locally re-exports a binding imported from ${packageName}`);
          }
        }
      }
      if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)
        && importedLocals.has(statement.expression.text)) {
        throw new Error(`${label} source ${source.path} locally re-exports a binding imported from ${packageName}`);
      }
    }
  }
}

function matchesPackage(specifier, packageName) {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

function staticImports(text) {
  const values = [];
  const source = ts.createSourceFile('boundary-source.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const importClause = statement.importClause;
      const namedBindings = importClause?.namedBindings;
      const typeOnly = importClause?.isTypeOnly === true
        || (importClause?.name === undefined
          && namedBindings !== undefined
          && ts.isNamedImports(namedBindings)
          && namedBindings.elements.length > 0
          && namedBindings.elements.every((element) => element.isTypeOnly));
      values.push({
        kind: 'import',
        clause: importClause?.getText(source) ?? '',
        specifier: statement.moduleSpecifier.text,
        typeOnly,
      });
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier
      && ts.isStringLiteral(statement.moduleSpecifier)) {
      const exportClause = statement.exportClause;
      const typeOnly = statement.isTypeOnly
        || (exportClause !== undefined
          && ts.isNamedExports(exportClause)
          && exportClause.elements.length > 0
          && exportClause.elements.every((element) => element.isTypeOnly));
      values.push({
        kind: 'export',
        clause: exportClause?.getText(source) ?? '*',
        specifier: statement.moduleSpecifier.text,
        typeOnly,
      });
    } else if (ts.isImportEqualsDeclaration(statement)
      && ts.isExternalModuleReference(statement.moduleReference)
      && statement.moduleReference.expression
      && ts.isStringLiteral(statement.moduleReference.expression)) {
      values.push({
        kind: 'import',
        clause: statement.name.text,
        specifier: statement.moduleReference.expression.text,
        typeOnly: statement.isTypeOnly,
      });
    }
  }
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (dynamicImport || requireCall) {
        const specifier = node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])
          ? node.arguments[0].text
          : undefined;
        values.push({ kind: 'dynamic', clause: '', specifier, typeOnly: false });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return values;
}

function requireImportBinding(sources, sourcePath, specifier, binding, label) {
  const source = sources.find((item) => item.path === sourcePath);
  if (!source || !staticImports(source.text).some((item) => item.specifier === specifier && binding.test(item.clause))) {
    throw new Error(`${label} must import ${binding} directly from ${specifier} in ${sourcePath}`);
  }
}

function requireWorkspacePackage(name) {
  const value = packageByName.get(name);
  if (!value) throw new Error(`Required workspace package ${name} is missing`);
  return value;
}

function assertExactKeys(value, expected, label) {
  const observed = Object.keys(value ?? {}).sort();
  const canonicalExpected = [...expected].sort();
  if (JSON.stringify(observed) !== JSON.stringify(canonicalExpected)) {
    throw new Error(`${label} is ${JSON.stringify(observed)}, expected ${JSON.stringify(canonicalExpected)}`);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function requireText(value, expected, label) {
  if (typeof value !== 'string' || !value.includes(expected)) {
    throw new Error(`${label} is missing ${JSON.stringify(expected)}`);
  }
}

function rejectText(value, forbidden, label) {
  if (typeof value === 'string' && value.includes(forbidden)) {
    throw new Error(`${label} must be absent`);
  }
}
