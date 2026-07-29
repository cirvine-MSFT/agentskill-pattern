'use strict';

const fs = require('fs');
const path = require('path');
const {
  canonicalJson,
  parentModel,
  readJson,
  resolveContainedPath,
  root,
  sha256,
  sha256RawFile,
  specialistModel
} = require('./lib');
const { validateSchema } = require('./validate-schema');

const sourceSchema = readJson(path.join(root, 'schemas', 'artifact-bundle.schema.json'));
const blindSchema = readJson(path.join(root, 'schemas', 'blind-content.schema.json'));
const prohibitedMetadataAssignment = /(?:\b(?:condition(?:Instruction)?|requestedModel|observedModel|parentModel|specialistModel|judgeModel|sessionId|targetSessionId|coordinatorSessionId|scheduleId|runId|modelRouting|delegationEvidence)\b(?:\\?["'])?\s*(?::|=)|(?:\\?["'])routing(?:\\?["'])\s*:)/im;
const conditionRevealingMarkers = [
  /\b(?:generated|created|written|produced|implemented|edited|authored)\s+by\s+(?:a\s+|the\s+)?(?:delegated\s+)?(?:specialist|sub[- ]?agent|nested\s+(?:agent|session)|delegate)\b/i,
  /\bdelegat(?:ed|ion|ing)\s+(?:to|by|via|through|a\s+|the\s+)?(?:specialist|sub[- ]?agent|nested\s+(?:agent|session))\b/i,
  /\b(?:delegated\s+specialist|specialist\s+(?:session|agent|model)|sub[- ]?agent\s+(?:session|model)|nested\s+(?:agent|session))\b/i,
  /\b(?:control|treatment)\s+(?:condition|arm|group|run|session|candidate|artifact|output)\b/i,
  /\b(?:condition|experimental\s+arm|benchmark\s+arm)\s*(?:is|was|:|=)\s*(?:control|treatment)\b/i,
  /\b(?:parent|specialist|nested|delegated|coordinator|root|trial|judge)\s+session\b/i,
  /\bsession\s+(?:id|identifier)\b/i,
  /\b(?:requested|observed|parent|specialist|judge)\s+model\b/i,
  /\b(?:model[- ]?routing|routed?\s+to\s+(?:a\s+|the\s+)?(?:model|specialist|sub[- ]?agent|claude|gpt))\b/i,
  /\bcreate_banner_only\b/i
];

function assertNoProhibitedMetadata(serialized, forbiddenValues, label) {
  const invariantCaseFold = (value) => value.normalize('NFKC').toLowerCase();
  const normalizedSerialized = invariantCaseFold(serialized);
  const containsForbidden = (value) => {
    return typeof value === 'string' &&
      value.length > 0 &&
      normalizedSerialized.includes(invariantCaseFold(value));
  };
  if (prohibitedMetadataAssignment.test(serialized) ||
      forbiddenValues.some(containsForbidden)) {
    throw new Error(`${label} contains condition/model/session/run metadata leakage, including routing metadata.`);
  }
}

function assertNoConditionRevealingProvenance(value, label) {
  const textValues = (item) => {
    if (typeof item === 'string') return [item];
    if (Array.isArray(item)) return item.flatMap(textValues);
    if (item && typeof item === 'object') return Object.values(item).flatMap(textValues);
    return [];
  };
  if (textValues(value).some((text) => conditionRevealingMarkers.some((marker) => marker.test(text)))) {
    throw new Error(`${label} contains a prohibited high-confidence condition-revealing provenance marker.`);
  }
}

function sanitizedDeterministic(record) {
  return {
    status: record.status,
    groups: ['functional', 'art', 'tamperCheck'].map((name) => ({
      name,
      status: record[name].status,
      assertions: record[name].assertions.map((assertion) => ({
        id: assertion.id,
        status: assertion.status,
        message: assertion.message
      }))
    }))
  };
}

function validateRelativeArtifactPath(value, label) {
  const normalized = value.replace(/\\/g, '/');
  if (path.isAbsolute(value) || normalized.startsWith('/') ||
      normalized.split('/').some((segment) => segment === '..' || segment === '')) {
    throw new Error(`${label} must be a normalized relative artifact path.`);
  }
}

function authenticateArtifactBundle(artifactRoot, artifact, manifest, prompt, deterministic) {
  const bundlePath = resolveContainedPath(artifactRoot, artifact.bundlePath, `${artifact.runId} artifact bundlePath`);
  if (!fs.existsSync(bundlePath) || !fs.statSync(bundlePath).isFile()) {
    throw new Error(`${artifact.runId} authenticated artifact bundle bytes are missing.`);
  }
  const actualHash = sha256RawFile(bundlePath);
  if (actualHash !== artifact.bundleSha256 || actualHash !== manifest.refs.artifactBundleSha256) {
    throw new Error(`${artifact.runId} authenticated artifact bundle bytes do not match the selected run hash.`);
  }

  const source = readJson(bundlePath);
  const schemaErrors = validateSchema(source, sourceSchema);
  if (schemaErrors.length > 0) {
    throw new Error(`${artifact.runId} source artifact bundle leaks metadata or violates its schema: ${schemaErrors.join('; ')}`);
  }
  if (source.promptId !== manifest.promptId || source.prompt !== prompt.prompt) {
    throw new Error(`${artifact.runId} source artifact prompt does not match the preregistered prompt.`);
  }
  if (canonicalJson(source.deterministic) !== canonicalJson(sanitizedDeterministic(deterministic))) {
    throw new Error(`${artifact.runId} source artifact deterministic result is not authenticated to the run result.`);
  }
  if (new Set(source.files.map((file) => file.path)).size !== source.files.length) {
    throw new Error(`${artifact.runId} source artifact file paths must be unique.`);
  }
  source.files.forEach((file) => validateRelativeArtifactPath(file.path, `${artifact.runId} ${file.path}`));
  const bannerFiles = source.files.filter((file) => file.role === 'banner');
  if (bannerFiles.length > 1 || (bannerFiles.length === 1 && bannerFiles[0].path !== prompt.banner.path)) {
    throw new Error(`${artifact.runId} source artifact may contain only the preregistered banner path.`);
  }
  if (deterministic.art.status === 'pass' && bannerFiles.length !== 1) {
    throw new Error(`${artifact.runId} passed deterministic art must contain the preregistered banner.`);
  }
  source.files.forEach((file) => {
    const allowed = file.role === 'banner'
      ? file.path === prompt.banner.path
      : (file.role === 'source'
        ? file.path.startsWith('src/')
        : (file.role === 'fixture_test'
          ? file.path.startsWith('tests/')
          : file.path === 'terminal.diff'));
    if (!allowed) {
      throw new Error(`${artifact.runId} source artifact ${file.role} path is not metadata-safe.`);
    }
  });
  const serialized = canonicalJson(source);
  const forbiddenValues = [
    manifest.conditionInstruction,
    manifest.runId,
    manifest.scheduleId,
    manifest.execution.rootSessionId,
    manifest.execution.coordinatorSessionId,
    manifest.sessions.parent.sessionId,
    manifest.condition === 'treatment' ? manifest.sessions.specialist.sessionId : null,
    manifest.sessions.parent.requestedModel,
    manifest.sessions.parent.observedModel,
    manifest.condition === 'treatment' ? manifest.sessions.specialist.requestedModel : null,
    manifest.condition === 'treatment' ? manifest.sessions.specialist.observedModel : null,
    manifest.workspace.identifier,
    manifest.workspace.branch,
    manifest.timestamps.createdAt,
    manifest.timestamps.promptSentAt,
    manifest.timestamps.completedAt,
    'create_banner_only'
  ];
  assertNoProhibitedMetadata(serialized, forbiddenValues, `${artifact.runId} source artifact`);
  assertNoConditionRevealingProvenance({
    deterministic: source.deterministic,
    files: source.files
  }, `${artifact.runId} source artifact candidate content`);

  const expectedFiles = source.files.map((file) => {
    const bytes = Buffer.from(file.content, 'utf8');
    return {
      path: file.path,
      sha256: sha256(bytes),
      bytes: bytes.length,
      role: file.role
    };
  });
  if (canonicalJson(expectedFiles) !== canonicalJson(artifact.files)) {
    throw new Error(`${artifact.runId} artifact manifest does not describe the authenticated source bytes.`);
  }
  return { bundlePath, source, actualHash };
}

function buildBlindContent(blindId, source) {
  return {
    protocolId: source.protocolId,
    blindId,
    promptId: source.promptId,
    prompt: source.prompt,
    deterministic: source.deterministic,
    files: source.files
  };
}

function validateBlindContent(blindId, source, blindPath) {
  const value = readJson(blindPath);
  const schemaErrors = validateSchema(value, blindSchema);
  if (schemaErrors.length > 0) {
    throw new Error(`${blindId} blind bundle violates its metadata-safe schema: ${schemaErrors.join('; ')}`);
  }
  assertNoProhibitedMetadata(
    canonicalJson(value),
    [parentModel, specialistModel, 'create_banner_only'],
    `${blindId} blind bundle`
  );
  assertNoConditionRevealingProvenance({
    deterministic: value.deterministic,
    files: value.files
  }, `${blindId} blind bundle candidate content`);
  const expectedBytes = canonicalJson(buildBlindContent(blindId, source));
  const actualBytes = fs.readFileSync(blindPath, 'utf8');
  if (actualBytes !== expectedBytes) {
    throw new Error(`${blindId} blind bundle was not generated from the authenticated selected artifact bytes.`);
  }
  return sha256(Buffer.from(actualBytes, 'utf8'));
}

module.exports = {
  assertNoConditionRevealingProvenance,
  assertNoProhibitedMetadata,
  authenticateArtifactBundle,
  buildBlindContent,
  sanitizedDeterministic,
  validateBlindContent
};
