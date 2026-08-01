import {
  ledgerSchemaErrors,
  normalizeText,
  protocolId,
  semanticallyCompatible,
  tokenF1,
} from "../scripts/lib.mjs";

function pairItems(candidateItems, expectedItems) {
  const edges = [];
  for (const [candidateIndex, candidate] of candidateItems.entries()) {
    for (const [goldIndex, expected] of expectedItems.entries()) {
      const owner = normalizeText(candidate.owner) === normalizeText(expected.owner);
      const similarity = tokenF1(candidate.action, expected.action);
      if (owner && similarity >= 0.55 && semanticallyCompatible(candidate.action, expected.action)) {
        edges.push({ candidateIndex, goldIndex, similarity });
      }
    }
  }
  edges.sort((a, b) => b.similarity - a.similarity || a.candidateIndex - b.candidateIndex || a.goldIndex - b.goldIndex);
  const candidates = new Set();
  const gold = new Set();
  return edges.filter((edge) => {
    if (candidates.has(edge.candidateIndex) || gold.has(edge.goldIndex)) return false;
    candidates.add(edge.candidateIndex);
    gold.add(edge.goldIndex);
    return true;
  });
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function canonicalCitation(citation) {
  return `${citation?.startLineId ?? ""}\0${citation?.endLineId ?? ""}\0${citation?.quote ?? ""}`;
}

function citationExistsInTranscript(citation, transcriptLines) {
  const start = Number.parseInt(citation?.startLineId?.slice(1, -1), 10);
  const end = Number.parseInt(citation?.endLineId?.slice(1, -1), 10);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > transcriptLines.length) return false;
  const expectedPrefix = (line) => `[${String(line).padStart(3, "0")}]`;
  if (citation.startLineId !== expectedPrefix(start) || citation.endLineId !== expectedPrefix(end)) return false;
  return transcriptLines.slice(start - 1, end).join("\n") === citation.quote;
}

function citationsExactlyGrounded(candidate, target, transcriptLines) {
  if (!Array.isArray(candidate.sourceCitations) || candidate.sourceCitations.length !== target.sourceCitations.length) return false;
  const candidateSet = candidate.sourceCitations.map(canonicalCitation).sort();
  const targetSet = target.sourceCitations.map(canonicalCitation).sort();
  return candidateSet.every((citation, index) => citation === targetSet[index])
    && candidate.sourceCitations.every((citation) => citationExistsInTranscript(citation, transcriptLines));
}

function evaluateAmbiguities(candidateAmbiguities, expectedOmissions, transcriptLines) {
  const expected = expectedOmissions.filter((omission) => omission.category === "material-ambiguity");
  const candidates = Array.isArray(candidateAmbiguities) ? candidateAmbiguities : [];
  const matched = expected.filter((target) => candidates.some((candidate) => {
    if (!Array.isArray(candidate.sourceCitations) || candidate.sourceCitations.length !== target.sourceCitations.length) return false;
    const left = candidate.sourceCitations.map(canonicalCitation).sort();
    const right = target.sourceCitations.map(canonicalCitation).sort();
    return left.every((citation, index) => citation === right[index])
      && candidate.sourceCitations.every((citation) => citationExistsInTranscript(citation, transcriptLines))
      && tokenF1(candidate.note, target.reason) >= 0.55
      && semanticallyCompatible(candidate.note, target.reason);
  }));
  return {
    expected: expected.length,
    candidate: candidates.length,
    matched: matched.length,
    noteSimilarityMinimum: 0.55,
    completeAndExactlyGrounded: matched.length === expected.length && candidates.length === expected.length,
  };
}

export function evaluateLedger({ ledger, gold, transcript, run }) {
  const schemaErrors = ledgerSchemaErrors(ledger, run);
  const candidates = Array.isArray(ledger?.items) ? ledger.items : [];
  const expected = gold.expectedItems;
  const pairs = pairItems(candidates, expected);
  const transcriptLines = transcript.trimEnd().split(/\r?\n/u);
  const rows = pairs.map((pair) => {
    const candidate = candidates[pair.candidateIndex];
    const target = expected[pair.goldIndex];
    return {
      ...pair,
      owner: normalizeText(candidate.owner) === normalizeText(target.owner),
      action: pair.similarity >= 0.80 && semanticallyCompatible(candidate.action, target.action),
      dueDate: candidate.dueDate === target.dueDate,
      status: candidate.status === target.status,
      condition: normalizeText(candidate.condition) === normalizeText(target.condition),
      criticality: candidate.criticality === target.criticality,
      goldCritical: target.criticality === "critical",
      grounded: citationsExactlyGrounded(candidate, target, transcriptLines),
      resolutionTags: target.resolutionTags,
    };
  });
  const tupleCorrectRows = rows.filter((row) =>
    row.owner && row.action && row.dueDate && row.status && row.condition && row.criticality);
  const precision = candidates.length ? tupleCorrectRows.length / candidates.length : 0;
  const recall = expected.length ? tupleCorrectRows.length / expected.length : 1;
  const ambiguity = evaluateAmbiguities(ledger?.ambiguities, gold.expectedOmissions, transcriptLines);
  const unsupportedCandidateIndexes = candidates.map((_, index) => index)
    .filter((index) => !pairs.some((pair) => pair.candidateIndex === index));
  const unsupportedCriticalActions = candidates.filter((candidate, candidateIndex) =>
    candidate?.criticality === "critical"
    && !rows.some((row) => row.candidateIndex === candidateIndex && row.action && row.goldCritical)).length;
  const duplicateKeys = candidates.map((item) => `${normalizeText(item.owner)}\0${normalizeText(item.action)}\0${item.dueDate ?? ""}`);
  const resolutionCorrect = (tag) => rows.some((row) =>
    row.resolutionTags.includes(tag) && row.owner && row.dueDate && row.status && row.condition);
  const rescinded = gold.expectedOmissions.filter((omission) => omission.category === "rescission");
  const rescissionCorrect = rescinded.every((omission) => !candidates.some((candidate) =>
    normalizeText(candidate.owner) === normalizeText(omission.owner) && tokenF1(candidate.action, omission.action) >= 0.55));
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  const reassignmentEligible = expected.filter((item) => item.resolutionTags.includes("reassignment")).length;
  const reassignmentCorrect = Number(resolutionCorrect("reassignment"));
  const dateChangeEligible = expected.filter((item) => item.resolutionTags.includes("date-change")).length;
  const dateChangeCorrect = Number(resolutionCorrect("date-change"));
  return {
    formatVersion: 3,
    protocolId,
    runId: run.runId,
    transcriptId: run.transcriptId,
    tuple: {
      definition: "Canonical owner, action, final due date, status, condition, and criticality must all match.",
      candidateCount: candidates.length,
      goldCount: expected.length,
      pairedCount: pairs.length,
      matchedCount: tupleCorrectRows.length,
      precision,
      recall,
      f1,
    },
    fieldAccuracy: {
      owner: mean(rows.map((row) => Number(row.owner))),
      action: mean(rows.map((row) => Number(row.action))),
      dueDate: mean(rows.map((row) => Number(row.dueDate))),
      status: mean(rows.map((row) => Number(row.status))),
      condition: mean(rows.map((row) => Number(row.condition))),
      criticality: mean(rows.map((row) => Number(row.criticality))),
    },
    changeHandling: {
      rescission: { eligible: rescinded.length, correct: rescissionCorrect ? rescinded.length : 0, rate: rescissionCorrect ? 1 : 0 },
      reassignment: { eligible: reassignmentEligible, correct: reassignmentCorrect, rate: reassignmentEligible ? reassignmentCorrect / reassignmentEligible : 1 },
      dateChange: { eligible: dateChangeEligible, correct: dateChangeCorrect, rate: dateChangeEligible ? dateChangeCorrect / dateChangeEligible : 1 },
    },
    unsupportedCommitments: unsupportedCandidateIndexes.length,
    unsupportedCriticalActions,
    schema: { valid: schemaErrors.length === 0, errors: schemaErrors },
    duplicates: duplicateKeys.length - new Set(duplicateKeys).size,
    sourceGrounding: {
      definition: "Exact gold source line/range identifiers and complete prefixed transcript quote are required.",
      candidateItems: candidates.length,
      matchedItems: rows.length,
      groundedItems: rows.filter((row) => row.grounded).length,
      expectedAmbiguities: ambiguity.expected,
      groundedAmbiguities: ambiguity.matched,
      rate: candidates.length + ambiguity.expected
        ? (rows.filter((row) => row.grounded).length + ambiguity.matched) / (candidates.length + ambiguity.expected)
        : 0,
    },
    ambiguity,
    matches: rows,
  };
}
