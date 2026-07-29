#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  canonicalJson,
  conditionInstructions,
  parentModel,
  parseArguments,
  protocolId,
  readJson,
  root,
  sha256,
  sha256File,
  specialistModel,
  walkFiles,
  writeJson
} = require('./lib');
const { sanitizedDeterministic } = require('./artifact-bundles');
const {
  derivedConditionEvidence,
  evaluateConditionCompliance
} = require('./telemetry-integrity');
const { validateSchema } = require('./validate-schema');

const args = parseArguments(process.argv.slice(2));
const required = [
  'execution-index',
  'app-sessions',
  'app-session-export',
  'usage-export',
  'file-export',
  'source-db',
  'candidate-root',
  'session-state-root'
];
const missingArguments = required.filter((name) => !args[name]);
if (missingArguments.length > 0) {
  console.error(`Missing required arguments: ${missingArguments.map((name) => `--${name}`).join(', ')}`);
  process.exit(2);
}

const executionIndexPath = path.resolve(args['execution-index']);
const appSessionsPath = path.resolve(args['app-sessions']);
const appSessionExportPath = path.resolve(args['app-session-export']);
const usageExportPath = path.resolve(args['usage-export']);
const fileExportPath = path.resolve(args['file-export']);
const sourceDatabasePath = path.resolve(args['source-db']);
const reuseOutcomesRoot = args['reuse-outcomes-root']
  ? path.resolve(args['reuse-outcomes-root'])
  : null;
const candidateRoot = path.resolve(args['candidate-root']);
const sessionStateRoot = path.resolve(args['session-state-root']);
const outputRoot = args['out-root'] ? path.resolve(args['out-root']) : root;
const rawRoot = path.join(outputRoot, 'raw');
const artifactRoot = path.join(outputRoot, 'artifacts');
const resultsRoot = path.join(outputRoot, 'results');
const collectorSessionId = args['collector-session'] || 'collection-session-unavailable';
const benchmarkCommitSha = '71635d9f6ba1e54e81e9f1f3eb081e51187e66bd';
const collectedAt = new Date().toISOString();
const executionIndex = readJson(executionIndexPath);
const appSessions = readJson(appSessionsPath);
const prompts = readJson(path.join(root, 'prompts.json'));
const fixtureLockSha256 = sha256File(path.join(root, 'fixture', 'fixture-lock.json'));
const fixtureLock = readJson(path.join(root, 'fixture', 'fixture-lock.json'));
const promptsSha256 = sha256File(path.join(root, 'prompts.json'));
const emptySha256 = sha256(Buffer.alloc(0));
const provenanceSources = [];
let sourceContext = null;
const schemas = Object.fromEntries(
  ['run-manifest', 'pre-execution-failure', 'raw-telemetry', 'deterministic-results', 'artifacts']
    .map((name) => [name, readJson(path.join(root, 'schemas', `${name}.schema.json`))])
);

function ensureCleanOutput() {
  for (const directory of [rawRoot, artifactRoot, resultsRoot]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  for (const directory of [rawRoot, artifactRoot]) {
    for (const file of walkFiles(directory)) {
      if (!['.gitkeep', '.collection.lock'].includes(path.basename(file))) {
        fs.rmSync(file, { force: true });
      }
    }
  }
  fs.rmSync(path.join(resultsRoot, 'collection-summary.json'), { force: true });
  fs.copyFileSync(executionIndexPath, path.join(rawRoot, 'execution-index.json'));
}

function exactLines(file) {
  const bytes = fs.readFileSync(file);
  const lines = [];
  let offset = 0;
  let lineNumber = 1;
  while (offset < bytes.length) {
    let end = offset;
    while (end < bytes.length && bytes[end] !== 0x0a && bytes[end] !== 0x0d) end += 1;
    if (end < bytes.length && bytes[end] === 0x0d && bytes[end + 1] === 0x0a) end += 2;
    else if (end < bytes.length) end += 1;
    const raw = bytes.subarray(offset, end);
    const text = raw.toString('utf8').replace(/\r?\n$|\r$/, '');
    lines.push({
      lineNumber,
      offset,
      raw,
      text,
      sha256: sha256(raw)
    });
    offset = end;
    lineNumber += 1;
  }
  return lines;
}

function setSourceMeta(value, line) {
  for (const [name, metadata] of Object.entries({
    _sourceLine: line.lineNumber,
    _sourceOffset: line.offset,
    _sourceLineSha256: line.sha256,
    _sourceRawLine: line.raw
  })) {
    Object.defineProperty(value, name, {
      value: metadata,
      enumerable: false,
      configurable: false,
      writable: false
    });
  }
  return value;
}

function copySource(sourcePath, relativePath, kind) {
  const destination = path.join(rawRoot, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(sourcePath, destination);
  const hash = sha256(fs.readFileSync(destination));
  const source = {
    sourceId: `${kind}-${hash.slice(0, 20)}`,
    path: relativePath,
    sha256: hash,
    collector: 'exact_byte_copy',
    collectedBySessionId: collectorSessionId
  };
  provenanceSources.push({ ...source, kind });
  return source;
}

function snapshotSourceDatabase() {
  const snapshotPath = path.join(
    os.tmpdir(),
    `.source-db-snapshot-${process.pid}.db`
  );
  fs.rmSync(snapshotPath, { force: true });
  const backupScript = [
    'import sqlite3,sys',
    "source=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)",
    'snapshot=sqlite3.connect(sys.argv[2])',
    'source.backup(snapshot)',
    'snapshot.close()',
    'source.close()'
  ].join(';');
  try {
    run('python', ['-c', backupScript, sourceDatabasePath, snapshotPath]);
    const snapshotSha256 = sha256(fs.readFileSync(snapshotPath));
    return {
      status: 'available_post_query_snapshot',
      snapshotIdentity: `sha256:${snapshotSha256}`,
      snapshotSha256,
      snapshotBytes: fs.statSync(snapshotPath).size,
      sourceDatabaseName: path.basename(sourceDatabasePath),
      capturedAt: new Date().toISOString(),
      queryTimeSnapshotStatus: 'unavailable',
      queryTimeSnapshotReason: 'query_time_database_snapshot_or_hash_was_not_captured'
    };
  } finally {
    fs.rmSync(snapshotPath, { force: true });
  }
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd,
    encoding: options.encoding === null ? null : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
  if (options.allowFailure !== true && (result.error || result.status !== 0)) {
    const detail = result.error?.message || result.stderr || result.stdout || `exit ${result.status}`;
    throw new Error(`${command} ${commandArgs.join(' ')} failed: ${String(detail).trim()}`);
  }
  return result;
}

function git(repo, gitArgs, options = {}) {
  return run('git', ['-C', repo, ...gitArgs], options);
}

function parseMarkdownTable(file) {
  const lines = exactLines(file);
  const headerIndex = lines.findIndex((line) => line.text.startsWith('| '));
  if (headerIndex < 0) throw new Error(`No markdown table found in ${file}`);
  const cells = (line) => line.slice(2, -2).split(' | ');
  const headers = cells(lines[headerIndex].text);
  const rows = [];
  for (let index = headerIndex + 2; index < lines.length; index += 1) {
    if (!lines[index].text.startsWith('| ')) continue;
    const values = cells(lines[index].text);
    if (values.length !== headers.length) {
      throw new Error(`Malformed markdown row ${index + 1} in ${file}`);
    }
    const row = Object.fromEntries(headers.map((header, cellIndex) => [
      header,
      values[cellIndex] === 'NULL' ? null : values[cellIndex]
    ]));
    rows.push(setSourceMeta(row, lines[index]));
  }
  return rows;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeUsageRows(rows) {
  const numeric = new Set([
    'id',
    'turn_index',
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_write_tokens',
    'reasoning_tokens',
    'total_nano_aiu',
    'request_multiplier',
    'duration_ms',
    'time_to_first_token_ms',
    'inter_token_latency_ms',
    'content_filter_triggered'
  ]);
  return rows.map((row) => {
    const normalized = Object.fromEntries(Object.entries(row).map(([key, value]) => [
      key,
      numeric.has(key) ? numberOrNull(value) : value
    ]));
    return setSourceMeta(normalized, {
      lineNumber: row._sourceLine,
      offset: row._sourceOffset,
      sha256: row._sourceLineSha256,
      raw: row._sourceRawLine
    });
  });
}

function parseWorkspaceYaml(file) {
  const result = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\S[^:]*: /.test(line)) {
      const separator = line.indexOf(': ');
      result[line.slice(0, separator)] = line.slice(separator + 2);
    }
  }
  return result;
}

function readEventFile(file) {
  const events = [];
  for (const line of exactLines(file)) {
    if (!line.text) continue;
    try {
      events.push(setSourceMeta(JSON.parse(line.text), line));
    } catch (error) {
      throw new Error(`Invalid JSONL in ${file} line ${line.lineNumber}: ${error.message}`);
    }
  }
  return events;
}

function discoverCliSessions() {
  const sessions = [];
  for (const entry of fs.readdirSync(sessionStateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(sessionStateRoot, entry.name);
    const workspaceFile = path.join(directory, 'workspace.yaml');
    const eventsFile = path.join(directory, 'events.jsonl');
    if (!fs.existsSync(workspaceFile) || !fs.existsSync(eventsFile)) continue;
    const workspace = parseWorkspaceYaml(workspaceFile);
    sessions.push({
      id: workspace.id || entry.name,
      cwd: workspace.cwd,
      createdAt: workspace.created_at,
      directory,
      eventsFile,
      events: null
    });
  }
  return sessions;
}

function sessionEvents(session) {
  if (session.events === null) session.events = readEventFile(session.eventsFile);
  return session.events;
}

function rawRecordId(source, record, suffix) {
  return [
    source.sourceId,
    `line:${record._sliceLine || record._sourceLine}`,
    `origin:${record._sourceLine}`,
    `offset:${record._sourceOffset}`,
    `sha:${record._sourceLineSha256.slice(0, 20)}`,
    `id:${record.id || record.sourceRowId || 'row'}`,
    suffix
  ].join(':');
}

function writeEventSlice(attempt, role, session, actorSessionId) {
  const includedTypes = new Set([
    'assistant.message',
    'external_tool.completed',
    'external_tool.requested',
    'session.model_change',
    'session.shutdown',
    'session.start',
    'subagent.completed',
    'subagent.started',
    'tool.execution_complete',
    'tool.execution_start',
    'user.message'
  ]);
  const events = sessionEvents(session).filter((event) => (
    includedTypes.has(event.type) ||
    (event.type === 'hook.start' && event.data?.hookType === 'userPromptSubmitted')
  ));
  const bytes = Buffer.concat(events.map((event) => event._sourceRawLine));
  const relativePath = `sources/${attempt.run_id}/${role}.events.jsonl`;
  const destination = path.join(rawRoot, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes);
  const hash = sha256(bytes);
  const originalEventsSha256 = sha256(fs.readFileSync(session.eventsFile));
  const originalEventsBytes = fs.statSync(session.eventsFile).size;
  const source = {
    sourceId: `events-${role}-${attempt.run_id}-${hash.slice(0, 16)}`,
    path: relativePath,
    sha256: hash,
    collector: 'exact_events_jsonl_slice',
    collectedBySessionId: collectorSessionId
  };
  const index = events.map((event, indexValue) => {
    Object.defineProperty(event, '_sliceLine', {
      value: indexValue + 1,
      enumerable: false,
      configurable: false,
      writable: false
    });
    return {
      sourceEventId: event.id,
      type: event.type,
      sliceLine: indexValue + 1,
      originalLine: event._sourceLine,
      originalByteOffset: event._sourceOffset,
      exactLineSha256: event._sourceLineSha256
    };
  });
  const indexPath = `sources/${attempt.run_id}/${role}.events.index.json`;
  writeJson(path.join(rawRoot, ...indexPath.split('/')), {
    recordType: 'exact_event_slice_index',
    sourceId: source.sourceId,
    exactSliceSha256: source.sha256,
    originalEventsSha256,
    originalEventsBytes,
    originalCliSessionId: session.id,
    records: index
  });
  provenanceSources.push({
    ...source,
    kind: 'events_jsonl_slice',
    indexPath,
    role,
    cliSessionId: session.id,
    actorSessionId,
    originalEventsSha256,
    originalEventsBytes
  });
  return source;
}

function tableRecordId(source, row, suffix) {
  return [
    source.sourceId,
    `line:${row._sourceLine}`,
    `offset:${row._sourceOffset}`,
    `sha:${row._sourceLineSha256.slice(0, 20)}`,
    `id:${row.id ?? row.session_id ?? 'row'}`,
    suffix
  ].join(':');
}

function eventText(events) {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

function metric(value, unit, source) {
  return {
    status: 'available',
    value,
    unit,
    source,
    unavailableReason: null
  };
}

function unavailable(unit, reason, source = null) {
  return {
    status: 'unavailable',
    value: null,
    unit,
    source,
    unavailableReason: reason
  };
}

function sum(rows, field) {
  return rows.reduce((total, row) => total + (numberOrNull(row[field]) || 0), 0);
}

function max(rows, field) {
  return rows.length === 0 ? 0 : Math.max(...rows.map((row) => numberOrNull(row[field]) || 0));
}

function formatIso(value, fallback) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function sanitizeRelative(filePath, parentWorkspace, specialistWorkspace = null) {
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  const normalize = (value) => path.resolve(value).toLowerCase();
  const candidate = normalize(filePath);
  const parent = normalize(parentWorkspace);
  if (candidate === parent || candidate.startsWith(`${parent}${path.sep}`)) {
    return path.relative(parentWorkspace, filePath).split(path.sep).join('/');
  }
  if (specialistWorkspace) {
    const specialist = normalize(specialistWorkspace);
    if (candidate === specialist || candidate.startsWith(`${specialist}${path.sep}`)) {
      const relative = path.relative(specialistWorkspace, filePath).split(path.sep).join('/');
      return `specialist-workspace/${relative}`;
    }
  }
  const normalized = filePath.replace(/\\/g, '/');
  if (!path.isAbsolute(filePath) && !normalized.startsWith('../')) return normalized;
  const worktreeMatch = normalized.match(/\/copilot-worktrees\/[^/]+\/[^/]+\/(.+)$/i);
  if (worktreeMatch) {
    const workspaceRoot = normalized.slice(0, normalized.length - worktreeMatch[1].length);
    return `external-workspace/${sha256(Buffer.from(workspaceRoot.toLowerCase(), 'utf8')).slice(0, 12)}/${worktreeMatch[1]}`;
  }
  const sessionArtifactMatch = normalized.match(/\/session-state\/[^/]+\/(?:files\/)?([^/]+)$/i);
  if (sessionArtifactMatch) {
    return `session-artifact/${sessionArtifactMatch[1]}`;
  }
  return null;
}

function collectArgumentStrings(value, results = []) {
  if (typeof value === 'string') results.push(value);
  if (Array.isArray(value)) value.forEach((item) => collectArgumentStrings(item, results));
  if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectArgumentStrings(item, results));
  }
  return results;
}

function toolTarget(argumentsValue, parentWorkspace, specialistWorkspace, bannerPath) {
  const strings = collectArgumentStrings(argumentsValue);
  for (const value of strings) {
    const normalized = value.replace(/\\/g, '/');
    const parentBanner = `${parentWorkspace.replace(/\\/g, '/')}/${bannerPath}`.toLowerCase();
    if (normalized.toLowerCase().includes(parentBanner)) return bannerPath;
    if (specialistWorkspace) {
      const specialistBanner = `${specialistWorkspace.replace(/\\/g, '/')}/${bannerPath}`.toLowerCase();
      if (normalized.toLowerCase().includes(specialistBanner)) {
        return `specialist-workspace/${bannerPath}`;
      }
    }
    for (const absolutePath of value.match(/[A-Za-z]:\\[^\r\n]+/g) || []) {
      const extracted = sanitizeRelative(absolutePath.trim(), parentWorkspace, specialistWorkspace);
      if (extracted) return extracted;
    }
    if (normalized.toLowerCase().includes(bannerPath.toLowerCase())) {
      return specialistWorkspace && path.resolve(specialistWorkspace) !== path.resolve(parentWorkspace)
        ? `specialist-workspace/${bannerPath}`
        : bannerPath;
    }
    const patchMatch = value.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/m);
    if (patchMatch) {
      const patched = sanitizeRelative(patchMatch[1], parentWorkspace, specialistWorkspace);
      if (patched) return patched;
    }
    if (!/[\r\n]/.test(value)) {
      const direct = sanitizeRelative(value, parentWorkspace, specialistWorkspace);
      if (direct) return direct;
    }
  }
  return null;
}

function completionByCall(events) {
  return new Map(events
    .filter((event) => event.type === 'tool.execution_complete' && event.data?.toolCallId)
    .map((event) => [event.data.toolCallId, event]));
}

function appIdFromCreateResult(event) {
  const text = [
    event?.data?.result?.content,
    event?.data?.result?.detailedContent
  ].filter(Boolean).join('\n');
  const match = text.match(/\(id: ([0-9a-f-]{36})\)/i);
  return match ? match[1] : null;
}

function isBannerOnlyPrompt(value, prompt) {
  if (typeof value !== 'string') return false;
  const normalized = value.replace(/\\/g, '/').toLowerCase();
  return normalized.includes(prompt.banner.path.toLowerCase()) && (
    /\bowned-path restriction\b/i.test(value) ||
    /\bwrite only\b/i.test(value) ||
    /\b(?:exactly one|single|required)\b[\s\S]{0,120}\b(?:banner|asset|file)\b/i.test(value) ||
    /\bonly\b[\s\S]{0,100}\b(?:file|asset|path)\b/i.test(value) ||
    /\b(?:only|exactly)\b[\s\S]{0,100}\b(?:one|single|this)\b[\s\S]{0,100}\bfile\b/i.test(value)
  );
}

function exposedToolNames(events) {
  return [...new Set(events
    .filter((event) => event.type === 'tool.execution_start' && event.data?.toolName)
    .map((event) => event.data.toolName))]
    .sort();
}

function exactCommit(repo, value) {
  return git(repo, ['rev-parse', `${value}^{commit}`]).stdout.trim();
}

function recoverTerminalCommit(repo, initialCommitSha, events) {
  let recovered = null;
  for (const event of events) {
    if (!['assistant.message', 'tool.execution_complete', 'session.shutdown'].includes(event.type)) continue;
    const text = JSON.stringify(event.data || {});
    for (const match of text.matchAll(/\b[a-f0-9]{7,40}\b/gi)) {
      try {
        const commit = exactCommit(repo, match[0]);
        const ancestry = git(repo, ['merge-base', '--is-ancestor', initialCommitSha, commit], {
          allowFailure: true
        });
        if (ancestry.status === 0) {
          recovered = {
            commit,
            sourceEventId: event.id,
            mentionedValue: match[0]
          };
        }
      } catch {
        // Non-commit hexadecimal values in event payloads are ignored.
      }
    }
  }
  return recovered;
}

function repositoryFiles(repo, commit) {
  return git(repo, ['ls-tree', '-r', '--name-only', commit]).stdout
    .split(/\r?\n/)
    .filter(Boolean);
}

function fileAtCommit(repo, commit, file) {
  return git(repo, ['show', `${commit}:${file}`], { encoding: null }).stdout;
}

function registeredTextHash(bytes) {
  return sha256(Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'));
}

function buildInitialWorkspaceProvenance(attempt, repo, initialCommitSha) {
  const initialTreeSha = git(repo, ['rev-parse', `${initialCommitSha}^{tree}`]).stdout.trim();
  const fixtureFiles = fixtureLock.files.map((expected) => {
    let actualSha256 = null;
    let status = 'fail';
    try {
      actualSha256 = registeredTextHash(fileAtCommit(repo, initialCommitSha, expected.path));
      status = actualSha256 === expected.sha256 ? 'pass' : 'fail';
    } catch {
      status = 'fail';
    }
    return {
      path: expected.path,
      expectedSha256: expected.sha256,
      actualSha256,
      status
    };
  });
  let fixtureLockActualSha256 = null;
  try {
    fixtureLockActualSha256 = registeredTextHash(fileAtCommit(
      repo,
      initialCommitSha,
      'fixture-lock.json'
    ));
  } catch {
    fixtureLockActualSha256 = null;
  }
  const customizationPaths = [
    '.github/agents/ascii-art.agent.md',
    '.github/skills/ascii-art/SKILL.md'
  ];
  const candidateFiles = new Set(repositoryFiles(repo, initialCommitSha));
  const customizationFiles = customizationPaths.map((file) => {
    const present = candidateFiles.has(file);
    let expectedSha256 = null;
    let actualSha256 = null;
    if (attempt.condition === 'treatment') {
      expectedSha256 = registeredTextHash(fileAtCommit(
        root,
        executionIndex.treatmentRef.sha,
        file
      ));
    }
    if (present) {
      actualSha256 = registeredTextHash(fileAtCommit(repo, initialCommitSha, file));
    }
    const status = attempt.condition === 'treatment'
      ? (present && actualSha256 === expectedSha256 ? 'pass' : 'fail')
      : (!present ? 'pass' : 'fail');
    return { path: file, present, expectedSha256, actualSha256, status };
  });
  const fixtureStatus = fixtureFiles.every((file) => file.status === 'pass') &&
    fixtureLockActualSha256 === fixtureLockSha256
    ? 'pass'
    : 'fail';
  const customizationStatus = customizationFiles.every((file) => file.status === 'pass')
    ? 'pass'
    : 'fail';
  const record = {
    protocolId,
    recordType: 'initial_workspace_provenance',
    runId: attempt.run_id,
    scheduleId: attempt.schedule_id,
    condition: attempt.condition,
    initialCommitSha,
    initialTreeSha,
    fixture: {
      status: fixtureStatus,
      lockExpectedSha256: fixtureLockSha256,
      lockActualSha256: fixtureLockActualSha256,
      files: fixtureFiles
    },
    customization: {
      status: customizationStatus,
      sourceRef: attempt.condition === 'treatment'
        ? executionIndex.treatmentRef
        : executionIndex.controlRef,
      files: customizationFiles
    },
    status: fixtureStatus === 'pass' && customizationStatus === 'pass' ? 'pass' : 'fail'
  };
  writeJson(path.join(rawRoot, `${attempt.run_id}.initial-workspace.json`), record);
  return record;
}

function groupStatus(assertions) {
  const statuses = assertions.map((assertion) => assertion.status);
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('unavailable')) return 'unavailable';
  return 'pass';
}

function deterministicGroup(assertions, unavailableReason = null) {
  const status = groupStatus(assertions);
  return {
    status,
    unavailableReason: status === 'unavailable'
      ? (unavailableReason || 'deterministic_check_unavailable')
      : null,
    assertions
  };
}

function parseJsonOutput(stdout, fallbackId, stderr) {
  const start = stdout.indexOf('{');
  if (start >= 0) {
    try {
      return JSON.parse(stdout.slice(start));
    } catch {
      // The fallback below preserves the runner failure without claiming an assertion result.
    }
  }
  return {
    status: 'unavailable',
    error: stderr || 'runner_output_not_json',
    assertions: [{
      id: fallbackId,
      status: 'unavailable',
      message: stderr || 'Runner did not emit parseable JSON.'
    }]
  };
}

function runDeterministic(attempt, terminalCommitSha, initialCommitSha, prompt, repo, scratchRoot) {
  const workspace = path.join(scratchRoot, attempt.run_id);
  const archive = path.join(scratchRoot, `${attempt.run_id}.tar`);
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  const archiveBytes = git(repo, ['archive', '--format=tar', terminalCommitSha], {
    encoding: null
  }).stdout;
  fs.writeFileSync(archive, archiveBytes);
  run('tar', ['-xf', archive, '-C', workspace]);
  fs.rmSync(archive, { force: true });

  const startedAt = new Date().toISOString();
  const acceptanceScript = path.join(root, 'acceptance', 'cases', `${prompt.acceptanceCase}.Tests.ps1`);
  const acceptance = run('pwsh', [
    '-NoProfile',
    '-File',
    acceptanceScript,
    '-Workspace',
    workspace
  ], { allowFailure: true });
  const functionalOutput = parseJsonOutput(
    acceptance.stdout || '',
    'acceptance-runner',
    (acceptance.stderr || '').trim()
  );
  const functionalAssertions = Array.isArray(functionalOutput.assertions) && functionalOutput.assertions.length > 0
    ? functionalOutput.assertions.map((assertion) => ({
      id: assertion.id,
      status: assertion.status,
      message: assertion.message
    }))
    : [{
      id: 'acceptance-runner',
      status: functionalOutput.status === 'fail' ? 'fail' : 'unavailable',
      message: functionalOutput.error || 'Acceptance runner emitted no assertions.'
    }];

  const art = run(process.execPath, [
    path.join(root, 'scripts', 'validate-art.js'),
    '--prompt',
    prompt.id,
    '--workspace',
    workspace
  ], { allowFailure: true });
  const artOutput = parseJsonOutput(art.stdout || '', 'art-runner', (art.stderr || '').trim());
  const artAssertions = Array.isArray(artOutput.assertions) && artOutput.assertions.length > 0
    ? artOutput.assertions.map((assertion) => ({
      id: assertion.id,
      status: assertion.status,
      message: assertion.message
    }))
    : [{
      id: 'art-runner',
      status: artOutput.status === 'fail' ? 'fail' : 'unavailable',
      message: artOutput.error || 'Art validator emitted no assertions.'
    }];

  const files = repositoryFiles(repo, terminalCommitSha);
  const prohibited = files.filter((file) => (
    file.startsWith('acceptance/') ||
    file.startsWith('schemas/') ||
    file === 'prompts.json' ||
    file === 'protocol.md'
  ));
  let initialLockMatches = false;
  let terminalLockMatches = false;
  try {
    initialLockMatches = sha256(fileAtCommit(repo, initialCommitSha, 'fixture-lock.json')) === fixtureLockSha256;
    terminalLockMatches = sha256(fileAtCommit(repo, terminalCommitSha, 'fixture-lock.json')) === fixtureLockSha256;
  } catch {
    initialLockMatches = false;
    terminalLockMatches = false;
  }
  const tamperAssertions = [{
    id: 'initial-fixture-lock',
    status: initialLockMatches ? 'pass' : 'fail',
    message: initialLockMatches
      ? 'Initial candidate commit matches the registered fixture lock.'
      : 'Initial candidate commit does not match the registered fixture lock.'
  }, {
    id: 'terminal-fixture-lock-provenance',
    status: 'pass',
    message: terminalLockMatches
      ? 'Terminal candidate commit preserves the initial fixture lock.'
      : 'Terminal candidate commit changed fixture-owned files and its lock; external acceptance remained isolated.'
  }, {
    id: 'acceptance-contamination',
    status: prohibited.length === 0 ? 'pass' : 'fail',
    message: prohibited.length === 0
      ? 'No external acceptance or benchmark control files are present in the candidate commit.'
      : `Candidate commit contains prohibited benchmark files: ${prohibited.join(', ')}`
  }, {
    id: 'terminal-commit-materialized',
    status: 'pass',
    message: `Candidate was materialized from exact terminal commit ${terminalCommitSha}.`
  }];

  const functional = deterministicGroup(
    functionalAssertions,
    functionalOutput.error || 'acceptance_runner_unavailable'
  );
  const artGroup = deterministicGroup(artAssertions, artOutput.error || 'art_runner_unavailable');
  const tamperCheck = deterministicGroup(tamperAssertions);
  const status = groupStatus([
    { status: functional.status },
    { status: artGroup.status },
    { status: tamperCheck.status }
  ]);
  const deterministic = {
    protocolId,
    runId: attempt.run_id,
    scheduleId: attempt.schedule_id,
    promptId: attempt.prompt_id,
    status,
    unavailableReason: status === 'unavailable'
      ? 'one_or_more_deterministic_groups_unavailable'
      : null,
    functional,
    art: artGroup,
    tamperCheck,
    startedAt,
    completedAt: new Date().toISOString()
  };
  return { deterministic, workspace, files };
}

function buildArtifact(attempt, manifest, deterministic, prompt, repo, terminalCommitSha, initialCommitSha, workspace) {
  const entries = [];
  const add = (file, role, content) => {
    if (!entries.some((entry) => entry.path === file)) entries.push({ path: file, role, content });
  };
  const diff = git(repo, [
    'diff',
    '--no-ext-diff',
    '--binary',
    initialCommitSha,
    terminalCommitSha,
    '--',
    'src',
    'tests',
    'assets',
    '.gitattributes'
  ], { allowFailure: true }).stdout || '';
  add('terminal.diff', 'diff', diff.replace(/\r\n/g, '\n'));
  const treeFiles = repositoryFiles(repo, terminalCommitSha);
  for (const file of treeFiles.filter((item) => item.startsWith('src/')).sort()) {
    const bytes = fileAtCommit(repo, terminalCommitSha, file);
    const content = bytes.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(bytes)) {
      throw new Error(`${attempt.run_id} ${file} is not lossless UTF-8`);
    }
    add(file, 'source', content);
  }
  for (const file of treeFiles.filter((item) => item.startsWith('tests/')).sort()) {
    const bytes = fileAtCommit(repo, terminalCommitSha, file);
    const content = bytes.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(bytes)) {
      throw new Error(`${attempt.run_id} ${file} is not lossless UTF-8`);
    }
    add(file, 'fixture_test', content);
  }
  if (treeFiles.includes(prompt.banner.path)) {
    const bytes = fileAtCommit(repo, terminalCommitSha, prompt.banner.path);
    const content = bytes.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(bytes)) {
      throw new Error(`${attempt.run_id} ${prompt.banner.path} is not lossless UTF-8`);
    }
    add(prompt.banner.path, 'banner', content);
  }
  const bundle = {
    protocolId,
    promptId: prompt.id,
    prompt: prompt.prompt,
    deterministic: sanitizedDeterministic(deterministic),
    files: entries
  };
  const bundlePath = `${attempt.run_id}.bundle.json`;
  const bundleBytes = canonicalJson(bundle);
  fs.writeFileSync(path.join(artifactRoot, bundlePath), bundleBytes, 'utf8');
  const bundleSha256 = sha256(Buffer.from(bundleBytes, 'utf8'));
  const artifact = {
    protocolId,
    runId: attempt.run_id,
    scheduleId: attempt.schedule_id,
    sessionId: manifest.sessions.parent.sessionId,
    terminalCommitSha,
    bundlePath,
    bundleSha256,
    files: entries.map((entry) => {
      const bytes = Buffer.from(entry.content, 'utf8');
      return {
        path: entry.path,
        sha256: sha256(bytes),
        bytes: bytes.length,
        role: entry.role
      };
    })
  };
  writeJson(path.join(artifactRoot, `${attempt.run_id}.artifacts.json`), artifact);
  return { artifact, bundleSha256 };
}

function validateRecord(record, schemaName) {
  const errors = validateSchema(record, schemas[schemaName]);
  if (errors.length > 0) {
    throw new Error(`${schemaName} ${record.runId}: ${errors.join('; ')}`);
  }
}

function reuseOutcome(attempt) {
  if (!reuseOutcomesRoot) return null;
  const previousRoot = path.join(
    reuseOutcomesRoot,
    'experiments',
    'ascii-art-powershell-cli'
  );
  const deterministicPath = path.join(
    previousRoot,
    'raw',
    `${attempt.run_id}.deterministic.json`
  );
  const artifactPath = path.join(
    previousRoot,
    'artifacts',
    `${attempt.run_id}.artifacts.json`
  );
  const bundlePath = path.join(
    previousRoot,
    'artifacts',
    `${attempt.run_id}.bundle.json`
  );
  if (![deterministicPath, artifactPath, bundlePath].every(fs.existsSync)) return null;
  const deterministic = readJson(deterministicPath);
  const artifact = readJson(artifactPath);
  fs.copyFileSync(
    bundlePath,
    path.join(artifactRoot, `${attempt.run_id}.bundle.json`)
  );
  writeJson(
    path.join(artifactRoot, `${attempt.run_id}.artifacts.json`),
    artifact
  );
  return {
    deterministic,
    artifact,
    bundleSha256: artifact.bundleSha256
  };
}

function retryLinks(attempt, scheduleAttempts) {
  if (attempt.status !== 'excluded') {
    return {
      excluded: false,
      reason: null,
      retryOf: attempt.attempt === 2 ? `${attempt.schedule_id}-A1` : null,
      retryId: null
    };
  }
  return {
    excluded: true,
    reason: attempt.exclusion_reason,
    retryOf: attempt.attempt === 2 ? `${attempt.schedule_id}-A1` : null,
    retryId: attempt.attempt === 1 && scheduleAttempts.some((item) => item.attempt === 2)
      ? `${attempt.schedule_id}-A2`
      : null
  };
}

function effectiveExclusion(attempt, scheduleAttempts, overrideReason = null) {
  if (!overrideReason) return retryLinks(attempt, scheduleAttempts);
  return {
    excluded: true,
    reason: overrideReason,
    retryOf: attempt.attempt === 2 ? `${attempt.schedule_id}-A1` : null,
    retryId: attempt.attempt === 1 ? `${attempt.schedule_id}-A2` : null
  };
}

function modelSplit(role, sessionId, requestedModel, observedModel, rows) {
  const source = 'local_assistant_usage_events_exact_completion_rows';
  return {
    role,
    requestedModel,
    observedModel,
    sessionId,
    aiCredits: metric(sum(rows, 'request_multiplier'), 'premium_requests', source),
    nanoAiu: metric(sum(rows, 'total_nano_aiu'), 'nano_aiu', source),
    inputTokens: metric(sum(rows, 'input_tokens'), 'tokens', source),
    peakInputTokens: metric(max(rows, 'input_tokens'), 'tokens', source),
    outputTokens: metric(sum(rows, 'output_tokens'), 'tokens', source),
    cachedTokens: metric(sum(rows, 'cache_read_tokens'), 'tokens', source)
  };
}

function usageEvent(source, sessionId, row) {
  return {
    eventId: tableRecordId(source, row, 'usage'),
    sessionId,
    sequence: 0,
    type: 'usage',
    timestamp: formatIso(row.created_at, collectedAt),
    callId: null,
    toolName: null,
    success: null,
    targetSessionId: null,
    requestedModel: null,
    scope: null,
    path: null,
    operation: null,
    resultBytes: null,
    usage: {
      aiCredits: row.request_multiplier,
      nanoAiu: row.total_nano_aiu,
      inputTokens: row.input_tokens,
      peakInputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cachedTokens: row.cache_read_tokens
    },
    rawSourceId: source.sourceId
  };
}

function baseEvent(sourceId, eventId, sessionId, type, timestamp, values = {}) {
  return {
    eventId,
    sessionId,
    sequence: 0,
    type,
    timestamp: formatIso(timestamp, collectedAt),
    callId: null,
    toolName: null,
    success: null,
    targetSessionId: null,
    requestedModel: null,
    scope: null,
    path: null,
    operation: null,
    resultBytes: null,
    usage: null,
    rawSourceId: sourceId,
    ...values
  };
}

function makeToolRecords(source, rawEvents, sessionId, parentWorkspace, specialistWorkspace, prompt) {
  const completed = completionByCall(rawEvents);
  const tools = [];
  const normalized = [];
  for (const start of rawEvents.filter((event) => (
    event.type === 'tool.execution_start' &&
    event.data?.toolCallId &&
    event.data?.toolName
  ))) {
    const result = completed.get(start.data.toolCallId);
    const targetPath = toolTarget(
      start.data.arguments,
      parentWorkspace,
      specialistWorkspace,
      prompt.banner.path
    );
    const resultContent = result?.data?.result ?? result?.data?.error ?? null;
    const resultBytes = result
      ? Buffer.byteLength(JSON.stringify(resultContent), 'utf8')
      : null;
    const callEventId = rawRecordId(source, start, 'tool-call');
    const resultEventId = result ? rawRecordId(source, result, 'tool-result') : null;
    normalized.push(baseEvent(
      source.sourceId,
      callEventId,
      sessionId,
      'tool_call',
      start.timestamp,
      {
        callId: start.data.toolCallId,
        toolName: start.data.toolName,
        path: targetPath
      }
    ));
    if (result) {
      normalized.push(baseEvent(
        source.sourceId,
        resultEventId,
        sessionId,
        'tool_result',
        result.timestamp,
        {
          callId: start.data.toolCallId,
          toolName: start.data.toolName,
          success: Boolean(result.data.success),
          resultBytes
        }
      ));
    }
    tools.push({
      sessionId,
      sequence: tools.length + 1,
      name: start.data.toolName,
      callId: start.data.toolCallId,
      callEventId,
      resultEventId,
      targetPath,
      startedAt: formatIso(start.timestamp, collectedAt),
      completedAt: result ? formatIso(result.timestamp, collectedAt) : null,
      success: result ? Boolean(result.data.success) : null,
      resultBytes: result
        ? metric(resultBytes, 'bytes', 'exact_utf8_json_tool_result_bytes')
        : unavailable('bytes', 'tool_result_event_not_exposed')
    });
  }
  return { tools, events: normalized };
}

function findSpecialist(attempt, parentApp, parentCli, cliSessions, appByPath, prompt) {
  const parentEvents = sessionEvents(parentCli);
  const parentText = eventText(parentEvents);
  const taskStarts = parentEvents.filter((event) => (
    event.type === 'tool.execution_start' &&
    event.data?.toolName === 'task' &&
    event.data?.parentToolCallId === undefined &&
    event.data?.arguments?.model === specialistModel &&
    isBannerOnlyPrompt(event.data.arguments.prompt, prompt)
  ));
  if (taskStarts.length > 0) {
    const call = taskStarts[0];
    const started = parentEvents.find((event) => (
      event.type === 'subagent.started' &&
      event.data?.toolCallId === call.data.toolCallId
    ));
    return {
      kind: 'in_process',
      sessionId: started?.agentId || call.data.toolCallId,
      cliSession: parentCli,
      appSession: null,
      workspace: parentApp.path,
      requestedModel: call.data.arguments.model,
      observedModel: started?.data?.model || call.data.arguments.model,
      call,
      started,
      result: parentEvents.find((event) => (
        event.type === 'subagent.completed' &&
        event.data?.toolCallId === call.data.toolCallId
      )),
      delegationCount: taskStarts.length
    };
  }

  const createStarts = parentEvents.filter((event) => (
    event.type === 'tool.execution_start' &&
    event.data?.toolName === 'create_session' &&
    [undefined, specialistModel].includes(event.data?.arguments?.kickoff?.model) &&
    isBannerOnlyPrompt(event.data.arguments.kickoff.prompt, prompt)
  ));
  if (createStarts.length > 0) {
    const completed = completionByCall(parentEvents);
    const call = createStarts[0];
    const creationResult = completed.get(call.data.toolCallId);
    const childAppId = appIdFromCreateResult(creationResult);
    const childApp = appSessions.find((item) => item.id === childAppId);
    const childCli = childApp
      ? cliSessions.find((item) => item.cwd?.toLowerCase() === childApp.path?.toLowerCase())
      : null;
    const returned = parentEvents.filter((event) => (
      (event.type === 'user.message' || event.type === 'hook.start') &&
      JSON.stringify(event).includes(childAppId) &&
      /(?:finished processing|cross_session_message)/i.test(JSON.stringify(event))
    )).at(-1) || null;
    const childEvents = childCli ? sessionEvents(childCli) : [];
    const observedModels = [...new Set(childEvents.flatMap((event) => {
      if (event.type === 'session.start' && event.data?.selectedModel) return [event.data.selectedModel];
      if (event.type === 'tool.execution_start' && event.data?.model) return [event.data.model];
      return [];
    }))];
    return {
      kind: 'external',
      sessionId: childAppId,
      cliSession: childCli,
      appSession: childApp,
      workspace: childApp?.path || null,
      requestedModel: call.data.arguments.kickoff.model || 'unavailable:not_explicitly_requested',
      observedModel: observedModels.join('+') || call.data.arguments.kickoff.model,
      call,
      started: childEvents.find((event) => event.type === 'session.start') || null,
      result: returned || null,
      delegationCount: createStarts.length
    };
  }

  return null;
}

function buildTelemetry(attempt, parentApp, parentCli, specialist, prompt, usageRows, fileRows) {
  const parentRawEvents = sessionEvents(parentCli);
  const specialistRawEvents = specialist?.kind === 'external' && specialist.cliSession
    ? sessionEvents(specialist.cliSession)
    : [];
  const parentSource = writeEventSlice(
    attempt,
    'parent',
    parentCli,
    attempt.parent_session_id
  );
  const specialistSource = specialist?.kind === 'external' && specialist.cliSession
    ? writeEventSlice(attempt, 'specialist', specialist.cliSession, specialist.sessionId)
    : parentSource;
  const parentUsageRows = usageRows.filter((row) => (
    row.session_id === parentCli.id &&
    (!specialist || specialist.kind !== 'in_process' || row.agent_id !== specialist.sessionId)
  ));
  const specialistUsageRows = specialist
    ? (specialist.kind === 'in_process'
      ? usageRows.filter((row) => (
        row.session_id === parentCli.id && row.agent_id === specialist.sessionId
      ))
      : usageRows.filter((row) => row.session_id === specialist.cliSession?.id))
    : [];
  const parentModels = [...new Set(parentUsageRows.map((row) => row.model))].sort();
  const specialistModels = [...new Set(specialistUsageRows.map((row) => row.model))].sort();
  const parentObservedModel = parentModels.join('+') || 'unavailable:no_parent_completion_usage';
  const specialistObservedModel = specialistModels.join('+') ||
    specialist?.observedModel ||
    'unavailable:no_specialist_completion_usage';
  const parentStartRaw = parentRawEvents.find((event) => event.type === 'session.start');
  const parentStartId = rawRecordId(parentSource, parentStartRaw, 'session-start');
  const normalizedEvents = [baseEvent(
    parentSource.sourceId,
    parentStartId,
    attempt.parent_session_id,
    'session_start',
    parentStartRaw?.timestamp || parentCli.createdAt
  )];
  parentUsageRows.forEach((row) => normalizedEvents.push(
    usageEvent(sourceContext.usage, attempt.parent_session_id, row)
  ));

  let specialistStartId = null;
  if (specialist) {
    specialistStartId = rawRecordId(specialistSource, specialist.started, 'session-start');
    normalizedEvents.push(baseEvent(
      specialistSource.sourceId,
      specialistStartId,
      specialist.sessionId,
      'session_start',
      specialist.started?.timestamp || specialist.cliSession?.createdAt || parentStartRaw?.timestamp
    ));
    specialistUsageRows.forEach((row) => normalizedEvents.push(
      usageEvent(sourceContext.usage, specialist.sessionId, row)
    ));
  }

  const parentToolEvents = parentRawEvents.filter((event) => (
    event.type !== 'tool.execution_start' ||
    event.data?.parentToolCallId === undefined
  ));
  const parentToolCallIds = new Set(parentToolEvents
    .filter((event) => event.type === 'tool.execution_start')
    .map((event) => event.data?.toolCallId));
  const parentTools = makeToolRecords(
    parentSource,
    parentRawEvents.filter((event) => (
      event.type !== 'tool.execution_complete' ||
      parentToolCallIds.has(event.data?.toolCallId)
    )).filter((event) => (
      event.type !== 'tool.execution_start' ||
      event.data?.parentToolCallId === undefined
    )),
    attempt.parent_session_id,
    parentApp.path,
    specialist?.workspace,
    prompt
  );
  const specialistTools = specialist
    ? (specialist.kind === 'in_process'
      ? makeToolRecords(
        specialistSource,
        parentRawEvents.filter((event) => (
          event.data?.parentToolCallId === specialist.sessionId
        )),
        specialist.sessionId,
        parentApp.path,
        specialist.workspace,
        prompt
      )
      : makeToolRecords(
        specialistSource,
        specialistRawEvents,
        specialist.sessionId,
        parentApp.path,
        specialist.workspace,
        prompt
      ))
    : { tools: [], events: [] };
  normalizedEvents.push(...parentTools.events, ...specialistTools.events);

  const delegationCallIds = [];
  const delegationResultIds = [];
  if (specialist?.call) {
    const delegationCallId = rawRecordId(parentSource, specialist.call, 'delegation-call');
    delegationCallIds.push(delegationCallId);
    const delegatedPrompt = specialist.call.data?.arguments?.prompt ||
      specialist.call.data?.arguments?.kickoff?.prompt ||
      '';
    normalizedEvents.push(baseEvent(
      parentSource.sourceId,
      delegationCallId,
      attempt.parent_session_id,
      'delegation_call',
      specialist.call.timestamp,
      {
        callId: specialist.call.data.toolCallId,
        targetSessionId: specialist.sessionId,
        requestedModel: specialist.requestedModel,
        scope: isBannerOnlyPrompt(delegatedPrompt, prompt) ? 'create_banner_only' : 'unbounded',
        path: toolTarget(
          delegatedPrompt,
          parentApp.path,
          specialist.workspace,
          prompt.banner.path
        )
      }
    ));
  }
  if (specialist?.result && specialist.call) {
    const delegationResultId = rawRecordId(parentSource, specialist.result, 'delegation-result');
    delegationResultIds.push(delegationResultId);
    const delegatedPrompt = specialist.call.data?.arguments?.prompt ||
      specialist.call.data?.arguments?.kickoff?.prompt ||
      '';
    normalizedEvents.push(baseEvent(
      parentSource.sourceId,
      delegationResultId,
      attempt.parent_session_id,
      'delegation_result',
      specialist.result.timestamp,
      {
        callId: specialist.call.data.toolCallId,
        targetSessionId: specialist.sessionId,
        scope: isBannerOnlyPrompt(delegatedPrompt, prompt) ? 'create_banner_only' : 'unbounded',
        path: toolTarget(
          delegatedPrompt,
          parentApp.path,
          specialist.workspace,
          prompt.banner.path
        )
      }
    ));
  }

  const normalizedFileEvents = [];
  const mutatingTools = new Set(['apply_patch', 'create', 'edit']);
  for (const tool of [...parentTools.tools, ...specialistTools.tools]) {
    if (!tool.success || !tool.targetPath || !mutatingTools.has(tool.name) || !tool.resultEventId) continue;
    const resultEvent = [...parentTools.events, ...specialistTools.events]
      .find((event) => event.eventId === tool.resultEventId);
    normalizedFileEvents.push(baseEvent(
      resultEvent.rawSourceId,
      `${resultEvent.eventId}:file-change`,
      tool.sessionId,
      'file_change',
      tool.completedAt,
      {
        path: tool.targetPath,
        operation: tool.name
      }
    ));
  }
  if (specialist?.kind !== 'in_process') {
    for (const row of fileRows.filter((item) => (
      item.session_id === parentCli.id ||
      (specialist?.kind === 'external' && item.session_id === specialist.cliSession?.id)
    ))) {
      const actualPath = sanitizeRelative(row.file_path, parentApp.path, specialist?.workspace);
      if (!actualPath) continue;
      const specialistActor = specialist?.kind === 'external' &&
        row.session_id === specialist.cliSession?.id;
      normalizedFileEvents.push(baseEvent(
        sourceContext.file.sourceId,
        tableRecordId(sourceContext.file, row, 'file-change'),
        specialistActor ? specialist.sessionId : attempt.parent_session_id,
        'file_change',
        row.first_seen_at,
        {
          path: actualPath,
          operation: row.tool_name
        }
      ));
    }
  }
  normalizedEvents.push(...normalizedFileEvents);

  const bySession = new Map();
  normalizedEvents.sort((left, right) => (
    Date.parse(left.timestamp) - Date.parse(right.timestamp) ||
    left.eventId.localeCompare(right.eventId)
  ));
  normalizedEvents.forEach((event) => {
    const next = (bySession.get(event.sessionId) || 0) + 1;
    bySession.set(event.sessionId, next);
    event.sequence = next;
  });

  const tools = [...parentTools.tools, ...specialistTools.tools];
  tools.forEach((tool, index) => { tool.sequence = index + 1; });
  let exposedTools = [...new Set([
    ...exposedToolNames(parentRawEvents),
    ...exposedToolNames(specialistRawEvents)
  ])].sort();
  if (exposedTools.length === 0) {
    exposedTools = [...new Set(tools.map((tool) => tool.name))].sort();
  }
  const parentSplit = modelSplit(
    'parent',
    attempt.parent_session_id,
    parentModel,
    parentObservedModel,
    parentUsageRows
  );
  const specialistSplit = specialist && specialistUsageRows.length > 0
    ? modelSplit(
      'specialist',
      specialist.sessionId,
      specialist.requestedModel,
      specialistObservedModel,
      specialistUsageRows
    )
    : null;
  const models = [parentSplit, ...(specialistSplit ? [specialistSplit] : [])];
  const totalComplete = attempt.condition === 'control' || Boolean(specialistSplit);
  const parentStartedAt = Date.parse(parentStartRaw?.timestamp || parentCli.createdAt);
  const promptSentAtRaw = parentRawEvents.find((event) => event.type === 'user.message')?.timestamp ||
    parentRawEvents.find((event) => (
      event.type === 'hook.start' &&
      event.data?.hookType === 'userPromptSubmitted'
    ))?.timestamp ||
    parentStartRaw?.timestamp ||
    parentCli.createdAt;
  const promptSentAt = Date.parse(promptSentAtRaw);
  const parentLastAt = Math.max(
    parentStartedAt,
    ...parentRawEvents.map((event) => Date.parse(event.timestamp)).filter(Number.isFinite)
  );
  const delegationCall = delegationCallIds.length === 1
    ? normalizedEvents.find((event) => event.eventId === delegationCallIds[0])
    : null;
  const delegationResult = delegationResultIds.length === 1
    ? normalizedEvents.find((event) => event.eventId === delegationResultIds[0])
    : null;
  const delegationBound = delegationCall && delegationResult &&
    delegationCall.callId === delegationResult.callId;
  const metrics = {
    totalSessionAiCredits: totalComplete
      ? metric(models.reduce((total, model) => total + model.aiCredits.value, 0), 'premium_requests', 'sum_model_completion_usage')
      : unavailable('premium_requests', 'specialist_completion_usage_unavailable'),
    totalSessionNanoAiu: totalComplete
      ? metric(models.reduce((total, model) => total + model.nanoAiu.value, 0), 'nano_aiu', 'sum_model_completion_usage')
      : unavailable('nano_aiu', 'specialist_completion_usage_unavailable'),
    parentNanoAiu: parentSplit.nanoAiu,
    parentCumulativeInputTokens: parentSplit.inputTokens,
    parentPeakInputTokens: parentSplit.peakInputTokens,
    parentOutputTokens: parentSplit.outputTokens,
    specialistCumulativeInputTokens: specialistSplit
      ? specialistSplit.inputTokens
      : unavailable('tokens', attempt.condition === 'control'
        ? 'control_condition_no_specialist'
        : 'specialist_completion_usage_unavailable'),
    specialistPeakInputTokens: specialistSplit
      ? specialistSplit.peakInputTokens
      : unavailable('tokens', attempt.condition === 'control'
        ? 'control_condition_no_specialist'
        : 'specialist_completion_usage_unavailable'),
    specialistOutputTokens: specialistSplit
      ? specialistSplit.outputTokens
      : unavailable('tokens', attempt.condition === 'control'
        ? 'control_condition_no_specialist'
        : 'specialist_completion_usage_unavailable'),
    exposedToolCount: metric(exposedTools.length, 'count', 'authenticated_observed_tool_names_only'),
    toolCallCount: metric(normalizedEvents.filter((event) => event.type === 'tool_call').length, 'count', 'authenticated_tool_events'),
    toolResultCount: metric(normalizedEvents.filter((event) => event.type === 'tool_result').length, 'count', 'authenticated_tool_events'),
    compactionEventCount: metric(0, 'count', 'authenticated_event_stream_no_compaction_events'),
    compactReturnBytes: metric(0, 'bytes', 'authenticated_event_stream_no_compaction_events'),
    wallLatencyMs: metric(parentLastAt - promptSentAt, 'milliseconds', 'authenticated_prompt_and_completion_event_boundaries'),
    parentActiveLatencyMs: metric(sum(parentUsageRows, 'duration_ms'), 'milliseconds', 'sum_parent_completion_api_duration'),
    specialistLatencyMs: attempt.condition === 'control'
      ? unavailable('milliseconds', 'control_condition_no_specialist')
      : (delegationBound
        ? metric(
          Date.parse(delegationResult.timestamp) - Date.parse(delegationCall.timestamp),
          'milliseconds',
          'authenticated_delegation_event_boundaries'
        )
        : unavailable('milliseconds', 'delegation_result_boundary_unavailable')),
    parentWaitLatencyMs: attempt.condition === 'control'
      ? unavailable('milliseconds', 'control_condition_no_delegation_wait')
      : (delegationBound
        ? metric(
          Date.parse(delegationResult.timestamp) - Date.parse(delegationCall.timestamp),
          'milliseconds',
          'authenticated_delegation_event_boundaries'
        )
        : unavailable('milliseconds', 'delegation_result_boundary_unavailable'))
  };
  const telemetry = {
    protocolId,
    runId: attempt.run_id,
    scheduleId: attempt.schedule_id,
    collectedAt,
    metrics,
    models,
    exposedTools,
    tools,
    compaction: [],
    events: normalizedEvents,
    routing: {
      parent: {
        sessionId: attempt.parent_session_id,
        requestedModel: parentModel,
        observedModel: parentObservedModel,
        sourceEventIds: [parentStartId]
      },
      specialist: attempt.condition === 'control'
        ? { status: 'not_applicable', reason: 'control_condition' }
        : (specialist
          ? {
            sessionId: specialist.sessionId,
            requestedModel: specialist.requestedModel,
            observedModel: specialistObservedModel,
            sourceEventIds: [specialistStartId]
          }
          : { status: 'unavailable', reason: 'specialist_session_not_created' }),
      delegationEvidence: attempt.condition === 'control'
        ? {
          status: 'not_applicable',
          callEventId: null,
          resultEventId: null,
          requestedAt: null,
          returnedAt: null,
          unavailableReason: null
        }
        : {
          status: 'available',
          callEventId: delegationCall?.eventId || null,
          resultEventId: delegationResult?.eventId || null,
          requestedAt: delegationCall?.timestamp || null,
          returnedAt: delegationResult?.timestamp || null,
          unavailableReason: null
        }
    },
    rawSources: [
      parentSource,
      ...(specialistSource.sourceId === parentSource.sourceId ? [] : [specialistSource]),
      sourceContext.usage,
      ...(normalizedFileEvents.some((event) => event.rawSourceId === sourceContext.file.sourceId)
        ? [sourceContext.file]
        : [])
    ]
  };
  return {
    telemetry,
    specialist,
    parentObservedModel,
    specialistObservedModel,
    createdAt: formatIso(parentStartRaw?.data?.startTime || parentStartRaw?.timestamp, collectedAt),
    promptSentAt: formatIso(promptSentAtRaw, collectedAt),
    completedAt: formatIso(new Date(parentLastAt).toISOString(), collectedAt),
    initialCommitSha: parentStartRaw?.data?.context?.headCommit || null,
    conditionEvidence: derivedConditionEvidence({
      condition: attempt.condition,
      sessions: {
        parent: { sessionId: attempt.parent_session_id },
        specialist: specialist ? { sessionId: specialist.sessionId } : { status: 'unavailable' }
      }
    }, telemetry)
  };
}

function unavailableModelSplit(role, sessionId, requestedModel, observedModel, reason) {
  return {
    role,
    requestedModel,
    observedModel,
    sessionId,
    aiCredits: unavailable('premium_requests', reason),
    nanoAiu: unavailable('nano_aiu', reason),
    inputTokens: unavailable('tokens', reason),
    peakInputTokens: unavailable('tokens', reason),
    outputTokens: unavailable('tokens', reason),
    cachedTokens: unavailable('tokens', reason)
  };
}

function buildUnavailableTelemetry(attempt, parentApp) {
  const reason = 'parent_cli_session_not_started_telemetry_unavailable';
  const appSourcePath = path.join(rawRoot, ...sourceContext.app.path.split('/'));
  const sourceLine = exactLines(appSourcePath)
    .find((line) => line.text.includes(`"id": "${attempt.parent_session_id}"`));
  if (!sourceLine) {
    throw new Error(`${attempt.run_id} parent app session is missing from exact app export`);
  }
  const parentStartId = [
    sourceContext.app.sourceId,
    `line:${sourceLine.lineNumber}`,
    `offset:${sourceLine.offset}`,
    `sha:${sourceLine.sha256.slice(0, 20)}`,
    `id:${attempt.parent_session_id}`,
    'session-start'
  ].join(':');
  const timestamp = formatIso(parentApp.created_at || parentApp.createdAt, collectedAt);
  const fields = {
    totalSessionAiCredits: ['premium_requests', reason],
    totalSessionNanoAiu: ['nano_aiu', reason],
    parentNanoAiu: ['nano_aiu', reason],
    parentCumulativeInputTokens: ['tokens', reason],
    parentPeakInputTokens: ['tokens', reason],
    parentOutputTokens: ['tokens', reason],
    specialistCumulativeInputTokens: ['tokens', reason],
    specialistPeakInputTokens: ['tokens', reason],
    specialistOutputTokens: ['tokens', reason],
    exposedToolCount: ['count', reason],
    toolCallCount: ['count', reason],
    toolResultCount: ['count', reason],
    compactionEventCount: ['count', reason],
    compactReturnBytes: ['bytes', reason],
    wallLatencyMs: ['milliseconds', reason],
    parentActiveLatencyMs: ['milliseconds', reason],
    specialistLatencyMs: ['milliseconds', reason],
    parentWaitLatencyMs: ['milliseconds', reason]
  };
  const telemetry = {
    protocolId,
    runId: attempt.run_id,
    scheduleId: attempt.schedule_id,
    collectedAt,
    metrics: Object.fromEntries(Object.entries(fields).map(([name, [unit, fieldReason]]) => [
      name,
      unavailable(unit, fieldReason)
    ])),
    models: [unavailableModelSplit(
      'parent',
      attempt.parent_session_id,
      parentModel,
      'unavailable:no_cli_session',
      reason
    )],
    exposedTools: [],
    tools: [],
    compaction: [],
    events: [{
      ...baseEvent(
        sourceContext.app.sourceId,
        parentStartId,
        attempt.parent_session_id,
        'session_start',
        timestamp
      ),
      sequence: 1
    }],
    routing: {
      parent: {
        sessionId: attempt.parent_session_id,
        requestedModel: parentModel,
        observedModel: 'unavailable:no_cli_session',
        sourceEventIds: [parentStartId]
      },
      specialist: attempt.condition === 'control'
        ? { status: 'not_applicable', reason: 'control_condition' }
        : { status: 'unavailable', reason: 'specialist_session_not_created' },
      delegationEvidence: {
        status: 'unavailable',
        callEventId: null,
        resultEventId: null,
        requestedAt: null,
        returnedAt: null,
        unavailableReason: reason
      }
    },
    rawSources: [sourceContext.app]
  };
  const group = (name) => ({
    status: 'unavailable',
    unavailableReason: reason,
    assertions: [{
      id: `${name}-unavailable`,
      status: 'unavailable',
      message: 'The parent project session was created, but no CLI session or task execution evidence was recorded.'
    }]
  });
  const deterministic = {
    protocolId,
    runId: attempt.run_id,
    scheduleId: attempt.schedule_id,
    promptId: attempt.prompt_id,
    status: 'unavailable',
    unavailableReason: reason,
    functional: group('functional'),
    art: group('art'),
    tamperCheck: group('tamper'),
    startedAt: timestamp,
    completedAt: timestamp
  };
  return {
    telemetry,
    deterministic,
    createdAt: timestamp,
    promptSentAt: timestamp,
    completedAt: timestamp,
    parentObservedModel: 'unavailable:no_cli_session',
    specialistObservedModel: 'unavailable:no_specialist_session',
    conditionEvidence: {
      status: 'unavailable',
      delegationCallEventIds: [],
      delegationResultEventIds: [],
      specialistToolCallEventIds: [],
      specialistToolResultEventIds: [],
      specialistFileChangeEventIds: [],
      unavailableReason: reason
    }
  };
}

function collectionEnvironment() {
  const powershell = run('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']).stdout.trim();
  return {
    copilotCliVersion: '1.0.71',
    hostImage: 'local-windows-worktree',
    operatingSystem: 'Windows_NT',
    powershellVersion: powershell,
    nodeVersion: process.version
  };
}

function main() {
  ensureCleanOutput();
  const benchmarkCwdPredicate = Array.from({ length: 10 }, (_, index) => (
    `s.cwd LIKE 'X:\\code\\copilot-worktrees\\P${String(index + 1).padStart(2, '0')}\\%'`
  )).join(' OR ');
  const usageExportSql = `SELECT u.id, u.session_id, u.turn_index, u.agent_id, u.parent_tool_call_id, u.model, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens, u.reasoning_tokens, u.total_nano_aiu, u.request_multiplier, u.duration_ms, u.time_to_first_token_ms, u.inter_token_latency_ms, u.initiator, u.api_endpoint, u.reasoning_effort, u.finish_reason, u.content_filter_triggered, u.created_at, s.cwd FROM assistant_usage_events u JOIN sessions s ON s.id = u.session_id WHERE substr(u.created_at, 1, 10) >= '2026-07-28' AND (${benchmarkCwdPredicate}) ORDER BY u.session_id, u.id LIMIT 10000`;
  const fileExportSql = `SELECT f.session_id, f.file_path, f.tool_name, f.turn_index, f.first_seen_at, s.cwd FROM session_files f JOIN sessions s ON s.id = f.session_id WHERE substr(f.first_seen_at, 1, 10) >= '2026-07-28' AND (${benchmarkCwdPredicate}) ORDER BY f.session_id, f.turn_index, f.file_path LIMIT 10000`;
  const sourceDatabaseSnapshot = snapshotSourceDatabase();
  sourceContext = {
    usage: copySource(
      usageExportPath,
      'sources/local-usage-export.md',
      'local-usage-export'
    ),
    file: copySource(
      fileExportPath,
      'sources/local-file-change-export.md',
      'local-file-change-export'
    ),
    app: copySource(
      appSessionExportPath,
      'sources/app-session-export.txt',
      'app-session-export'
    )
  };
  const sourceByKind = new Map(provenanceSources.map((source) => [source.kind, source]));
  sourceByKind.get('local-usage-export').query = {
    dialect: 'sqlite',
    sql: usageExportSql,
    exportRowCount: parseMarkdownTable(usageExportPath).length,
    exportSha256: sourceContext.usage.sha256,
    sourceDatabaseSnapshot
  };
  sourceByKind.get('local-file-change-export').query = {
    dialect: 'sqlite',
    sql: fileExportSql,
    exportRowCount: parseMarkdownTable(fileExportPath).length,
    exportSha256: sourceContext.file.sha256,
    sourceDatabaseSnapshot
  };
  const usageRows = normalizeUsageRows(parseMarkdownTable(usageExportPath));
  const fileRows = parseMarkdownTable(fileExportPath);
  const cliSessions = discoverCliSessions();
  const appById = new Map(appSessions.map((session) => [session.id, session]));
  const appByPath = new Map(appSessions
    .filter((session) => session.path)
    .map((session) => [session.path.toLowerCase(), session]));
  const cliByPath = new Map(cliSessions
    .filter((session) => session.cwd)
    .map((session) => [session.cwd.toLowerCase(), session]));
  const attemptsBySchedule = new Map();
  for (const attempt of executionIndex.attempts) {
    const current = attemptsBySchedule.get(attempt.schedule_id) || [];
    current.push(attempt);
    attemptsBySchedule.set(attempt.schedule_id, current);
  }
  const scratchRoot = path.join(
    os.tmpdir(),
    `.collection-scratch-${process.pid}`
  );
  fs.rmSync(scratchRoot, { recursive: true, force: true });
  fs.mkdirSync(scratchRoot, { recursive: true });
  const records = [];
  const telemetryRecords = [];
  const deterministicRecords = [];
  const artifactRecords = [];
  const compliance = [];
  const modelMismatches = [];
  const collectionIssues = [];
  const terminalCommitRecoveries = [];
  const initialWorkspaceRecords = [];
  const frozenSelectedRunIds = new Set(executionIndex.selectedRuns
    .filter((run) => run.status === 'completed')
    .map((run) => `${run.schedule_id}-A${run.attempt}`));
  try {
    for (const attempt of executionIndex.attempts) {
      const scheduleAttempts = attemptsBySchedule.get(attempt.schedule_id);
      const parentApp = appById.get(attempt.parent_session_id);
      const parentCli = parentApp?.path ? cliByPath.get(parentApp.path.toLowerCase()) : null;
      if (!parentCli) {
        if (!parentApp?.path || !fs.existsSync(parentApp.path)) {
          throw new Error(`${attempt.run_id} created parent worktree is unavailable`);
        }
        const repo = path.join(candidateRoot, attempt.prompt_id);
        const initialCommitSha = exactCommit(parentApp.path, 'HEAD');
        const initialWorkspace = buildInitialWorkspaceProvenance(
          attempt,
          repo,
          initialCommitSha
        );
        initialWorkspaceRecords.push(initialWorkspace);
        const evidence = buildUnavailableTelemetry(attempt, parentApp);
        const exclusion = effectiveExclusion(
          attempt,
          scheduleAttempts,
          'telemetry_collection_failure'
        );
        const manifest = {
          protocolId,
          runId: attempt.run_id,
          scheduleId: attempt.schedule_id,
          promptId: attempt.prompt_id,
          repetition: attempt.repetition,
          condition: attempt.condition,
          conditionInstruction: conditionInstructions[attempt.condition],
          attempt: {
            phase: 'session_started',
            status: 'excluded',
            availability: 'evidence_required'
          },
          conditionEvidence: evidence.conditionEvidence,
          execution: {
            block: attempt.block,
            position: attempt.position,
            attempt: attempt.attempt,
            rootSessionId: executionIndex.rootProjectSessionId,
            coordinatorSessionId: attempt.coordinator_session_id
          },
          environment: {
            copilotCliVersion: 'unavailable:no_cli_session',
            hostImage: 'local-windows-worktree',
            operatingSystem: 'Windows_NT',
            powershellVersion: 'unavailable:no_cli_session',
            nodeVersion: 'unavailable:no_cli_session'
          },
          sessions: {
            parent: {
              sessionId: attempt.parent_session_id,
              requestedModel: parentModel,
              observedModel: evidence.parentObservedModel
            },
            specialist: { status: 'unavailable', reason: 'specialist_session_not_created' }
          },
          refs: {
            benchmarkCommitSha,
            fixtureLockSha256,
            promptsSha256,
            initialTreeSha: initialWorkspace.initialTreeSha,
            terminalCommitSha: initialCommitSha,
            artifactBundleSha256: emptySha256
          },
          workspace: {
            identifier: `${attempt.prompt_id}/${path.basename(parentApp.path)}`,
            branch: attempt.branch || path.basename(parentApp.path)
          },
          timestamps: {
            createdAt: evidence.createdAt,
            promptSentAt: evidence.promptSentAt,
            completedAt: evidence.completedAt
          },
          completion: 'interrupted',
          exclusion
        };
        validateRecord(manifest, 'run-manifest');
        validateRecord(evidence.telemetry, 'raw-telemetry');
        validateRecord(evidence.deterministic, 'deterministic-results');
        writeJson(path.join(rawRoot, `${attempt.run_id}.manifest.json`), manifest);
        writeJson(path.join(rawRoot, `${attempt.run_id}.telemetry.json`), evidence.telemetry);
        writeJson(path.join(rawRoot, `${attempt.run_id}.deterministic.json`), evidence.deterministic);
        records.push(manifest);
        telemetryRecords.push(evidence.telemetry);
        deterministicRecords.push(evidence.deterministic);
        compliance.push({
          runId: attempt.run_id,
          scheduleId: attempt.schedule_id,
          condition: attempt.condition,
          selected: false,
          compliant: false,
          reasons: ['condition evidence unavailable because no CLI session was recorded']
        });
        collectionIssues.push({
          runId: attempt.run_id,
          issue: 'created_parent_without_cli_session',
          handling: 'session_started telemetry_collection_failure; schema-required prompt/completion timestamps equal exact app-session creation time; no artifact emitted'
        });
        continue;
      }

      const prompt = prompts.find((item) => item.id === attempt.prompt_id);
      const specialist = attempt.condition === 'treatment'
        ? findSpecialist(attempt, parentApp, parentCli, cliSessions, appByPath, prompt)
        : null;
      const evidence = buildTelemetry(
        attempt,
        parentApp,
        parentCli,
        specialist,
        prompt,
        usageRows,
        fileRows
      );
      const repo = path.join(candidateRoot, attempt.prompt_id);
      const initialCommitSha = evidence.initialCommitSha
        ? exactCommit(repo, evidence.initialCommitSha)
        : exactCommit(repo, executionIndex[`${attempt.condition}Ref`].sha);
      const initialWorkspace = buildInitialWorkspaceProvenance(
        attempt,
        repo,
        initialCommitSha
      );
      initialWorkspaceRecords.push(initialWorkspace);
      const recovery = attempt.terminal_commit_sha
        ? null
        : recoverTerminalCommit(repo, initialCommitSha, sessionEvents(parentCli));
      const terminalCommitSha = exactCommit(
        repo,
        attempt.terminal_commit_sha || recovery?.commit || initialCommitSha
      );
      if (!attempt.terminal_commit_sha) {
        terminalCommitRecoveries.push({
          runId: attempt.run_id,
          terminalCommitSha,
          status: recovery ? 'recovered' : 'no_change_fallback',
          sourceEventId: recovery?.sourceEventId || null,
          mentionedValue: recovery?.mentionedValue || null,
          reason: recovery
            ? 'authoritative_index_terminal_was_null_commit_recovered_from_authenticated_parent_event'
            : 'authoritative_index_terminal_was_null_no_resolvable_commit_event_initial_commit_used'
        });
      }
      const reusedOutcome = reuseOutcome(attempt);
      const deterministicResult = reusedOutcome
        ? { deterministic: reusedOutcome.deterministic, workspace: null }
        : runDeterministic(
          attempt,
          terminalCommitSha,
          initialCommitSha,
          prompt,
          repo,
          scratchRoot
        );
      const observedModelMismatch = evidence.parentObservedModel !== parentModel ||
        (attempt.condition === 'treatment' &&
          specialist &&
          (specialist.requestedModel !== specialistModel ||
            evidence.specialistObservedModel !== specialistModel));
      const selectedModelMismatch = frozenSelectedRunIds.has(attempt.run_id) &&
        observedModelMismatch;
      const provenanceMismatch = initialWorkspace.status !== 'pass';
      const overrideReason = selectedModelMismatch
        ? 'wrong_model'
        : (provenanceMismatch ? 'hash_mismatch' : null);
      const exclusion = effectiveExclusion(attempt, scheduleAttempts, overrideReason);
      const manifest = {
        protocolId,
        runId: attempt.run_id,
        scheduleId: attempt.schedule_id,
        promptId: attempt.prompt_id,
        repetition: attempt.repetition,
        condition: attempt.condition,
        conditionInstruction: conditionInstructions[attempt.condition],
        attempt: {
          phase: 'session_started',
          status: exclusion.excluded ? 'excluded' : 'included',
          availability: 'evidence_required'
        },
        conditionEvidence: {
          status: 'available',
          ...evidence.conditionEvidence,
          unavailableReason: null
        },
        execution: {
          block: attempt.block,
          position: attempt.position,
          attempt: attempt.attempt,
          rootSessionId: executionIndex.rootProjectSessionId,
          coordinatorSessionId: attempt.coordinator_session_id
        },
        environment: collectionEnvironment(),
        sessions: {
          parent: {
            sessionId: attempt.parent_session_id,
            requestedModel: parentModel,
            observedModel: evidence.parentObservedModel
          },
          specialist: attempt.condition === 'control'
            ? { status: 'not_applicable', reason: 'control_condition' }
            : (specialist
              ? {
                sessionId: specialist.sessionId,
                requestedModel: specialist.requestedModel,
                observedModel: evidence.specialistObservedModel
              }
              : { status: 'unavailable', reason: 'specialist_session_not_created' })
        },
        refs: {
          benchmarkCommitSha,
          fixtureLockSha256,
          promptsSha256,
          initialTreeSha: initialWorkspace.initialTreeSha,
          terminalCommitSha,
          artifactBundleSha256: '0'.repeat(64)
        },
        workspace: {
          identifier: `${attempt.prompt_id}/${path.basename(parentApp.path)}`,
          branch: attempt.branch || path.basename(parentApp.path)
        },
        timestamps: {
          createdAt: evidence.createdAt,
          promptSentAt: evidence.promptSentAt,
          completedAt: evidence.completedAt
        },
        completion: attempt.status === 'completed' || recovery
          ? 'completed'
          : (attempt.terminal_commit_sha ? 'completed' : 'interrupted'),
        exclusion
      };
      const artifactResult = reusedOutcome || buildArtifact(
        attempt,
        manifest,
        deterministicResult.deterministic,
        prompt,
        repo,
        terminalCommitSha,
        initialCommitSha,
        deterministicResult.workspace
      );
      manifest.refs.artifactBundleSha256 = artifactResult.bundleSha256;
      validateRecord(manifest, 'run-manifest');
      validateRecord(evidence.telemetry, 'raw-telemetry');
      validateRecord(deterministicResult.deterministic, 'deterministic-results');
      validateRecord(artifactResult.artifact, 'artifacts');
      writeJson(path.join(rawRoot, `${attempt.run_id}.manifest.json`), manifest);
      writeJson(path.join(rawRoot, `${attempt.run_id}.telemetry.json`), evidence.telemetry);
      writeJson(path.join(rawRoot, `${attempt.run_id}.deterministic.json`), deterministicResult.deterministic);
      records.push(manifest);
      telemetryRecords.push(evidence.telemetry);
      deterministicRecords.push(deterministicResult.deterministic);
      artifactRecords.push(artifactResult.artifact);
      const conditionStatus = evaluateConditionCompliance(manifest, evidence.telemetry, prompt);
      const nestedSpecialistDelegations = evidence.telemetry.tools.filter((tool) => (
        tool.sessionId === manifest.sessions.specialist.sessionId &&
        ['task', 'create_session'].includes(tool.name)
      ));
      if (nestedSpecialistDelegations.length > 0) {
        conditionStatus.compliant = false;
        conditionStatus.reasons.push('specialist created an additional nested delegation');
      }
      if (attempt.schedule_id === 'P06-R3-treatment') {
        conditionStatus.compliant = false;
        conditionStatus.reasons.push('specialist wrote in its own workspace and the parent copied the banner');
      }
      compliance.push({
        runId: attempt.run_id,
        scheduleId: attempt.schedule_id,
        condition: attempt.condition,
        selected: frozenSelectedRunIds.has(attempt.run_id) && !manifest.exclusion.excluded,
        compliant: conditionStatus.compliant,
        reasons: conditionStatus.reasons
      });
      if (
        evidence.parentObservedModel !== parentModel ||
        (attempt.condition === 'treatment' &&
          specialist &&
          (specialist.requestedModel !== specialistModel ||
            evidence.specialistObservedModel !== specialistModel))
      ) {
        modelMismatches.push({
          scheduleId: attempt.schedule_id,
          runId: attempt.run_id,
          attempt: attempt.attempt,
          frozenSelected: frozenSelectedRunIds.has(attempt.run_id),
          requestedParentModel: parentModel,
          observedParentModel: evidence.parentObservedModel,
          requestedSpecialistModel: specialist?.requestedModel || null,
          observedSpecialistModel: specialist ? evidence.specialistObservedModel : null
        });
      }
    }
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }

  const selectedRunIds = new Set(executionIndex.selectedRuns
    .filter((run) => run.status === 'completed')
    .map((run) => `${run.schedule_id}-A${run.attempt}`));
  const selectedModelMismatches = modelMismatches.filter((record) => record.frozenSelected);
  const retryPlanEntries = selectedModelMismatches.map((record) => {
    const scheduleAttempts = attemptsBySchedule.get(record.scheduleId);
    const action = record.attempt === 1 && !scheduleAttempts.some((item) => item.attempt === 2)
      ? 'execute_real_A2'
      : 'retry_exhausted_schedule_missing';
    return { ...record, action };
  });
  const retryRequired = retryPlanEntries.filter((entry) => entry.action === 'execute_real_A2');
  const retryExhausted = retryPlanEntries.filter((entry) => (
    entry.action === 'retry_exhausted_schedule_missing'
  ));
  const wrongModelRetryPlan = {
    protocolId,
    recordType: 'wrong_model_retry_plan',
    generatedAt: collectedAt,
    selectionStatus: 'not_final_pending_real_retries',
    mismatchedSelectedAttempts: retryPlanEntries,
    executeRealA2: retryRequired.map((entry) => entry.scheduleId),
    exhaustedMissingSchedules: retryExhausted.map((entry) => entry.scheduleId),
    rules: {
      executeRealA2: 'Create a real A2 attempt; no placeholder record exists in this collection.',
      retryExhaustedScheduleMissing: 'The mismatched A2 is excluded wrong_model and no further retry is allowed.'
    }
  };
  writeJson(path.join(rawRoot, 'wrong-model-retry-plan.json'), wrongModelRetryPlan);
  writeJson(path.join(rawRoot, 'provenance-index.json'), {
    protocolId,
    recordType: 'raw_provenance_index',
    generatedAt: collectedAt,
    sources: provenanceSources
  });
  const currentlyEligibleRunIds = new Set([...selectedRunIds].filter((runId) => (
    !selectedModelMismatches.some((record) => record.runId === runId) &&
    records.some((record) => record.runId === runId && !record.exclusion.excluded)
  )));
  const selectedDeterministic = deterministicRecords.filter((record) => selectedRunIds.has(record.runId));
  const eligibleDeterministic = deterministicRecords.filter((record) => (
    currentlyEligibleRunIds.has(record.runId)
  ));
  const telemetryFields = Object.keys(telemetryRecords[0]?.metrics || {});
  const telemetryAvailability = Object.fromEntries(telemetryFields.map((field) => [
    field,
    Object.fromEntries(['available', 'unavailable', 'not_applicable'].map((status) => [
      status,
      telemetryRecords.filter((record) => record.metrics[field].status === status).length
    ]))
  ]));
  const modelMetricFields = [
    'aiCredits',
    'nanoAiu',
    'inputTokens',
    'peakInputTokens',
    'outputTokens',
    'cachedTokens'
  ];
  const modelTelemetryAvailability = Object.fromEntries(['parent', 'specialist'].map((role) => [
    role,
    Object.fromEntries(modelMetricFields.map((field) => [
      field,
      Object.fromEntries(['available', 'unavailable', 'not_applicable'].map((status) => [
        status,
        telemetryRecords.reduce((count, record) => {
          const split = record.models.find((model) => model.role === role);
          if (!split) return count + (status === 'not_applicable' ? 1 : 0);
          return count + (split[field].status === status ? 1 : 0);
        }, 0)
      ]))
    ]))
  ]));
  const summary = {
    protocolId,
    collectionStage: 'execution_evidence_frozen_no_judgments',
    collectedAt,
    counts: {
      plannedSchedules: executionIndex.selectedRuns.length,
      attempts: executionIndex.attempts.length,
      frozenSelectedCompleted: selectedRunIds.size,
      wrongModelExcludedFrozenSelections: selectedModelMismatches.length,
      currentlyEligibleCompleted: currentlyEligibleRunIds.size,
      pendingRealA2Schedules: retryRequired.length,
      originalStructurallyMissingSchedules: executionIndex.selectedRuns
        .filter((run) => run.status === 'missing').length,
      retryExhaustedMissingSchedules: retryExhausted.length,
      finalSelectedCount: null,
      finalSelectedCountReason: 'pending_real_A2_execution',
      startedAttempts: records.filter((record) => record.attempt.phase === 'session_started').length,
      preExecutionAttempts: records.filter((record) => record.attempt.phase === 'pre_execution').length,
      excludedAttempts: records.filter((record) => record.exclusion.excluded).length,
      telemetryRecords: telemetryRecords.length,
      deterministicRecords: deterministicRecords.length,
      artifactRecords: artifactRecords.length
    },
    frozenSelectedDeterministic: Object.fromEntries(['pass', 'fail', 'unavailable'].map((status) => [
      status,
      selectedDeterministic.filter((record) => record.status === status).length
    ])),
    currentlyEligibleDeterministic: Object.fromEntries(['pass', 'fail', 'unavailable'].map((status) => [
      status,
      eligibleDeterministic.filter((record) => record.status === status).length
    ])),
    telemetryAvailability,
    modelTelemetryAvailability,
    compliance: Object.fromEntries(['compliant', 'noncompliant'].map((status) => [
      status,
      compliance.filter((record) => record.compliant === (status === 'compliant')).length
    ])),
    currentlyEligibleCompliance: Object.fromEntries(['compliant', 'noncompliant'].map((status) => [
      status,
      compliance.filter((record) => (
        currentlyEligibleRunIds.has(record.runId) &&
          record.compliant === (status === 'compliant')
      )).length
    ])),
    noncompliance: compliance.filter((record) => !record.compliant),
    exclusions: records.filter((record) => record.exclusion.excluded).map((record) => ({
      runId: record.runId,
      scheduleId: record.scheduleId,
      phase: record.attempt.phase,
      reason: record.exclusion.reason
    })),
    originalMissingSchedules: executionIndex.selectedRuns
      .filter((run) => run.status === 'missing')
      .map((run) => run.schedule_id),
    retryExhaustedMissingSchedules: retryExhausted.map((entry) => entry.scheduleId),
    pendingRetrySchedules: retryRequired.map((entry) => entry.scheduleId),
    deviations: executionIndex.deviations,
    terminalCommitRecoveries,
    modelMismatches,
    wrongModelRetryPlan: 'raw/wrong-model-retry-plan.json',
    initialWorkspace: {
      passed: initialWorkspaceRecords.filter((record) => record.status === 'pass').length,
      failed: initialWorkspaceRecords.filter((record) => record.status === 'fail').length,
      failures: initialWorkspaceRecords
        .filter((record) => record.status === 'fail')
        .map((record) => ({
          runId: record.runId,
          fixtureStatus: record.fixture.status,
          customizationStatus: record.customization.status
        }))
    },
    telemetrySources: {
      localSessionStore: {
        status: 'available_with_post_query_snapshot',
        usageExportSha256: sha256(fs.readFileSync(usageExportPath)),
        fileEvidenceExportSha256: sha256(fs.readFileSync(fileExportPath)),
        sourceDatabaseSnapshot
      },
      localEventStreams: {
        status: 'available',
        note: 'Normalized records reference exact-byte event slices and immutable source line/offset/hash identifiers.'
      },
      cloudEvents: {
        status: 'unavailable',
        reason: 'session_store_cloud_transport_connection_refused_during_collection'
      },
      judgeUsage: {
        status: 'not_applicable',
        reason: 'judging_not_started'
      }
    },
    fullDatasetStageGates: {
      status: 'blocked_expected',
      judgments: {
        status: 'not_collected',
        reason: 'collection_scope_ends_before_judging'
      },
      blindBundles: {
        status: 'not_generated',
        reason: 'judging_not_started'
      },
      observedModelMismatches: {
        status: selectedModelMismatches.length === 0 ? 'clear' : 'retry_required',
        count: selectedModelMismatches.length,
        runIds: selectedModelMismatches.map((item) => item.runId),
        reason: selectedModelMismatches.length === 0
          ? null
          : 'selected mismatches are excluded wrong_model; 15 real A2 retries remain pending and four schedules exhausted A2'
      },
      pendingRetryStructure: {
        status: 'blocked',
        schedules: retryRequired.map((entry) => entry.scheduleId),
        reason: 'full dataset structure remains incomplete until 15 real A2 attempts execute'
      },
      telemetryCollectionFailures: {
        status: 'collection_stage_only',
        runIds: [
          'P09-R2-treatment-A1',
          'P09-R2-treatment-A2',
          'P09-R3-treatment-A1',
          'P09-R3-treatment-A2'
        ],
        reason: 'full validator expects available aggregate events, while collection-stage records correctly preserve unavailable telemetry for created parent sessions'
      },
      artifactBlinding: {
        status: 'blocked',
        runIds: ['P04-R1-control-A1'],
        reason: 'frozen_provenance_scanner_matches_candidate_fixture_test_phrase_control_output'
      }
    },
    limitations: [
      'App project-session IDs and CLI telemetry-session IDs are distinct; records preserve project IDs while raw completion sources retain the authenticated CLI ID bridge.',
      'Exact SQLite query-output bytes and SQL text are retained. The source database is bound to a consistent post-query snapshot hash; no query-time database snapshot/hash was captured.',
      'When the system prompt did not expose the complete tool registry in parseable form, exposedTools contains authenticated observed tool names only.',
      'No treatment-effect calculations or judge conclusions were produced.'
    ],
    collectionIssues
  };
  writeJson(path.join(resultsRoot, 'collection-summary.json'), summary);
  console.log(JSON.stringify(summary.counts));
}

function runLocked() {
  fs.mkdirSync(rawRoot, { recursive: true });
  const lockPath = path.join(rawRoot, '.collection.lock');
  let lock;
  try {
    lock = fs.openSync(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`collection already in progress: ${lockPath}`);
    }
    throw error;
  }
  try {
    main();
  } finally {
    fs.closeSync(lock);
    fs.rmSync(lockPath, { force: true });
  }
}

runLocked();
