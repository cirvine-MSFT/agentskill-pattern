import { ledgerSchemaErrors, normalizeText, protocolId, tokenF1 } from "../scripts/lib.mjs";

function pairItems(candidateItems, expectedItems) {
  const edges = [];
  for (const [candidateIndex, candidate] of candidateItems.entries()) {
    for (const [goldIndex, expected] of expectedItems.entries()) {
      const owner = normalizeText(candidate.owner) === normalizeText(expected.owner);
      const similarity = tokenF1(candidate.action, expected.action);
      if (owner && similarity >= 0.55) edges.push({ candidateIndex, goldIndex, similarity });
    }
  }
  edges.sort((a, b) => b.similarity - a.similarity
    || a.candidateIndex - b.candidateIndex || a.goldIndex - b.goldIndex);
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

function grounded(span, lines) {
  return Number.isInteger(span?.startLine) && Number.isInteger(span?.endLine)
    && span.startLine >= 1 && span.endLine >= span.startLine && span.endLine <= lines.length
    && lines.slice(span.startLine - 1, span.endLine).join("\n").includes(span.quote);
}

export function evaluateLedger({ ledger, gold, transcript, run }) {
  const schemaErrors = ledgerSchemaErrors(ledger, run);
  const candidates = Array.isArray(ledger?.items) ? ledger.items : [];
  const expected = gold.expectedItems;
  const pairs = pairItems(candidates, expected);
  const precision = candidates.length ? pairs.length / candidates.length : 0;
  const recall = expected.length ? pairs.length / expected.length : 1;
  const lines = transcript.split(/\r?\n/u);
  const rows = pairs.map((pair) => {
    const candidate = candidates[pair.candidateIndex];
    const target = expected[pair.goldIndex];
    return {
      ...pair,
      owner: normalizeText(candidate.owner) === normalizeText(target.owner),
      action: pair.similarity >= 0.80,
      dueDate: candidate.dueDate === target.dueDate,
      status: candidate.status === target.status,
      condition: normalizeText(candidate.condition) === normalizeText(target.condition),
      criticality: candidate.criticality === target.criticality,
      grounded: Array.isArray(candidate.sourceSpans) && candidate.sourceSpans.length > 0
        && candidate.sourceSpans.every((span) => grounded(span, lines)),
      resolutionTags: target.resolutionTags,
    };
  });
  const unsupportedCandidateIndexes = candidates.map((_, index) => index)
    .filter((index) => !pairs.some((pair) => pair.candidateIndex === index));
  const unsupportedCriticalActions = unsupportedCandidateIndexes
    .filter((index) => candidates[index]?.criticality === "critical").length;
  const duplicateKeys = candidates.map((item) =>
    `${normalizeText(item.owner)}\0${normalizeText(item.action)}\0${item.dueDate ?? ""}`);
  const resolutionCorrect = (tag) => rows.some((row) =>
    row.resolutionTags.includes(tag) && row.owner && row.dueDate && row.status && row.condition);
  const rescinded = gold.expectedOmissions.filter((omission) => omission.category === "rescission");
  const rescissionCorrect = rescinded.every((omission) => !candidates.some((candidate) =>
    normalizeText(candidate.owner) === normalizeText(omission.owner)
    && tokenF1(candidate.action, omission.action) >= 0.55));
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  const reassignmentEligible = expected.filter((item) => item.resolutionTags.includes("reassignment")).length;
  const reassignmentCorrect = Number(resolutionCorrect("reassignment"));
  const dateChangeEligible = expected.filter((item) => item.resolutionTags.includes("date-change")).length;
  const dateChangeCorrect = Number(resolutionCorrect("date-change"));
  return {
    formatVersion: 2,
    protocolId,
    runId: run.runId,
    transcriptId: run.transcriptId,
    tuple: { candidateCount: candidates.length, goldCount: expected.length, matchedCount: pairs.length, precision, recall, f1 },
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
    unsupportedCandidateIndexes,
    schema: { valid: schemaErrors.length === 0, errors: schemaErrors },
    duplicates: duplicateKeys.length - new Set(duplicateKeys).size,
    sourceGrounding: {
      matchedItems: rows.length,
      groundedItems: rows.filter((row) => row.grounded).length,
      rate: rows.length ? rows.filter((row) => row.grounded).length / rows.length : 0,
    },
    matches: rows,
  };
}
