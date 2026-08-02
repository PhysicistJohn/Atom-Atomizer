#!/usr/bin/env node
/**
 * Assemble the v4 time-domain runtime package served from the web app.
 *
 * The three trained assets are produced by Atom-Classifier and land in its
 * `.artifacts/` staging directories. This step copies them verbatim -- the
 * bytes are what every SHA-256 binding in the package commits to, so they are
 * never reserialized -- and derives the manifest the browser loader validates.
 *
 * Staging admission only. A release promotion additionally rewrites `status`
 * to `release` and `release_evidence` to `true` inside each asset, re-derives
 * the cross-bindings against the rewritten classifier bytes, and pins the
 * resulting manifest digest in `TIME_DOMAIN_V4_RELEASE_MANIFEST_SHA256`. That
 * step asserts release-gate evidence and is deliberately not automated here.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const atomizerRoot = resolve(here, '..');
const classifierRoot = resolve(atomizerRoot, '..', 'Atom-Classifier');
const outputDirectory = join(atomizerRoot, 'apps/web/public/classifier/v4');

const CLASSIFIER_FILENAME = 'time-domain-profile-bank-v4.json';
const OPENSET_FILENAME = 'time-domain-profile-bank-openset-v4.json';
const DISPLAY_FILENAME = 'time-domain-profile-bank-display-calibration-v4.json';
const MANIFEST_FILENAME = 'runtime-package-manifest.json';

const RUNTIME_BUCKET_RULE =
  'largest_supported_prefix_not_exceeding_valid_sample_count';

/** Source artifact per packaged filename, with the contract each must satisfy. */
const SOURCES = [
  {
    filename: CLASSIFIER_FILENAME,
    source: join(
      classifierRoot,
      '.artifacts/v4-current-source-lineage-share13-browser-staging',
      CLASSIFIER_FILENAME,
    ),
    schema: 'atomos.v4.time-domain-current-source-profile-bank.browser-weights',
    schemaVersion: 2,
    status: 'staging_not_release',
    runtimeRole: 'accepted_known_classifier',
    requiredForDecision: true,
  },
  {
    filename: OPENSET_FILENAME,
    source: join(
      classifierRoot,
      '.artifacts/v4-openset-schema5-final-independent-design-seed20263001',
      OPENSET_FILENAME,
    ),
    schema: 'atomos.v4.time-domain-current-source.external-openset-policy',
    schemaVersion: 5,
    status: 'development_external_policy',
    runtimeRole: 'external_abstention_policy',
    requiredForDecision: true,
  },
  {
    filename: DISPLAY_FILENAME,
    source: join(
      classifierRoot,
      '.artifacts/v4-current-source-display-calibration-staging',
      DISPLAY_FILENAME,
    ),
    schema: 'atomos.v4.time-domain-profile-bank.display-calibration',
    schemaVersion: 1,
    status: 'staging_not_release',
    runtimeRole: 'conditional_display_calibration',
    requiredForDecision: false,
  },
];

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(message) {
  console.error(`package-v4-runtime-assets: ${message}`);
  process.exit(1);
}

function requireExact(actual, expected, path) {
  if (actual !== expected) {
    fail(`${path} must be ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}`);
  }
}

const packaged = new Map();
for (const descriptor of SOURCES) {
  let bytes;
  try {
    bytes = readFileSync(descriptor.source);
  } catch {
    fail(`missing source artifact ${descriptor.source}`);
  }
  const asset = JSON.parse(bytes.toString('utf8'));
  const path = descriptor.filename;
  requireExact(asset.schema, descriptor.schema, `${path}.schema`);
  requireExact(asset.schema_version, descriptor.schemaVersion, `${path}.schema_version`);
  requireExact(asset.status, descriptor.status, `${path}.status`);
  requireExact(asset.development_only, true, `${path}.development_only`);
  requireExact(asset.runtime_role, descriptor.runtimeRole, `${path}.runtime_role`);
  packaged.set(descriptor.filename, {
    descriptor,
    bytes,
    asset,
    sha256: sha256Hex(bytes),
  });
}

// The open-set policy and the display calibration each commit to the exact
// classifier bytes they were fitted against. Copying verbatim keeps those
// bindings valid; verify rather than assume, so a mismatched artifact set
// fails here instead of at browser startup.
const classifierSha256 = packaged.get(CLASSIFIER_FILENAME).sha256;
requireExact(
  packaged.get(OPENSET_FILENAME).asset.classifier_binding
    ?.browser_classifier_asset_sha256,
  classifierSha256,
  `${OPENSET_FILENAME}.classifier_binding.browser_classifier_asset_sha256`,
);
requireExact(
  packaged.get(DISPLAY_FILENAME).asset.classifier_asset_sha256,
  classifierSha256,
  `${DISPLAY_FILENAME}.classifier_asset_sha256`,
);

const manifest = {
  schema: 'atomos.v4.time-domain-profile-bank.runtime-package',
  schema_version: 1,
  status: 'staging_not_release',
  development_only: true,
  architecture: {
    classifier_and_policy_bytes_mutually_bound: true,
    trusted_prototype_source_required: true,
    classifier_precedes_route_conditioned_abstention: true,
    display_calibration_has_decision_authority: false,
    runtime_length_policy_by_prototype_source: {
      historical: {
        kind: RUNTIME_BUCKET_RULE,
        observation_length_reporting_rule: RUNTIME_BUCKET_RULE,
      },
      current: {
        kind: 'fixed_causal_prefix',
        effective_runtime_input_length: 4096,
        observation_length_reporting_rule: RUNTIME_BUCKET_RULE,
      },
    },
  },
  assets: Object.fromEntries(
    SOURCES.map(({ filename, schema, schemaVersion, runtimeRole, requiredForDecision }) => {
      const entry = packaged.get(filename);
      return [filename, {
        path: filename,
        bytes: entry.bytes.byteLength,
        sha256: entry.sha256,
        schema,
        schema_version: schemaVersion,
        runtime_role: runtimeRole,
        required_for_decision: requiredForDecision,
      }];
    }),
  ),
};

mkdirSync(outputDirectory, { recursive: true });
for (const [filename, entry] of packaged) {
  writeFileSync(join(outputDirectory, filename), entry.bytes);
}
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, undefined, 1)}\n`, 'utf8');
writeFileSync(join(outputDirectory, MANIFEST_FILENAME), manifestBytes);

for (const [filename, entry] of packaged) {
  console.log(`${entry.sha256}  ${filename}  (${entry.bytes.byteLength} bytes)`);
}
console.log(`${sha256Hex(manifestBytes)}  ${MANIFEST_FILENAME}  (${manifestBytes.byteLength} bytes)`);
console.log(`\nwrote ${outputDirectory}`);
