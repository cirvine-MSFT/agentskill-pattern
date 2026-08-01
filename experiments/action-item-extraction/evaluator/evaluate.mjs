import { readFileSync } from "node:fs";
import { ledgerSchemaErrors, normalizeText, tokenF1 } from "../scripts/lib.mjs";

function matches(candidateItems, goldItems) {
  const edges = [];
  for (const [candidateIndex, candidate] of candidateItems.entries()) {
    for (const [goldIndex, gold] of goldItems.entries()) {
      const ownerMatch = normalizeText(candidate.owner) === normalizeText(gold.owner);
      const similarity = tokenF1(candidate.action, gold.action);
      if (ownerMatch && similarity >= 0.55) edges.push({ candidateIndex, goldIndex, similarity });
    }
  }
  edges.sort((left, right) => right.similarity - left.similarity
    || left.candidateIndex - right.candidateIndex || left.goldIndex - right.goldIndex);
  const usedCandidates = new Set();
  const usedGold = new Set();
  return edges.filter((edge) => {
    if (usedCandidates.has(edge.candidateIndex) || usedGold.has(edge.goldIndex)) return false;
    usedCandidates.add(edge.candidateIndex);
    usedGold.add(edge.goldIndex);
    return true;
  });
}

function grounded(span, lines) {
  if (!Number.isInteger(span.startLine) || !Number.isInteger(span.endLine)) return false;
  if (span.startLine < 1 || span.endLine < span.startLine || span.endLine > lines.length) return false;
  return lines.slice(span.startLine - 1, span.endLine).join("\n").includes(span.quote);
}

function average(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function evaluateLedger({ ledger, gold, transcript, run }) {
  const schemaErrors = ledgerSchemaErrors(ledger, run);
  const candidateItems = Array.isArray(ledger?.items) ? ledger.items : [];
  const goldItems = gold.expectedItems;
  const paired = matches(candidateItems, goldItems);
  const precision = candidateItems.length === 0 ? 0 : paired.length / candidateItems.length;
  const recall = goldItems.length === 0 ? 1 : paired.length / goldItems.length;
  const tupleF1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const lines = transcript.split(/\r?\n/u);
  const fieldRows = paired.map((pair) => {
    const candidate = candidateItems[pair.candidateIndex];
    const expected = goldItems[pair.goldIndex];
    return {
      candidateIndex: pair.candidateIndex,
      goldIndex: pair.goldIndex,
      owner: normalizeText(candidate.owner) === normalizeText(expected.owner),
      action: pair.similarity >= 0.80,
      actionSimilarity: pair.similarity,
      dueDate: candidate.dueDate === expected.dueDate,
      status: candidate.status === expected.status,
      condition: normalizeText(candidate.condition) === normalizeText(expected.condition),
      criticality: candidate.criticality === expected.criticality,
      grounded: Array.isArray(candidate.sourceSpans)
        && candidate.sourceSpans.length > 0
        && candidate.sourceSpans.every((span) => grounded(span, lines)),
      resolutionTags: expected.resolutionTags,
    };
  });
  const duplicateKeys = candidateItems.map((item) =>
    `${normalizeText(item.owner)}\0${normalizeText(item.action)}\0${item.dueDate ?? ""}`);
  const duplicates = duplicateKeys.length - new Set(duplicateKeys).size;
  const unsupportedIndexes = candidateItems
    .map((_, index) => index)
    .filter((index) => !paired.some((pair) => pair.candidateIndex === index));
  const unsupportedCritical = unsupportedIndexes.filter((index) =>
    candidateItems[index]?.criticality === "critical");
  const resolutionGold = goldItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.resolutionTags.some((tag) =>
      ["reassignment", "rescission", "date-change", "retained-owner"].includes(tag)));
  const resolutionCorrect = resolutionGold.filter(({ index }) =>
    fieldRows.some((row) => row.goldIndex === index
      && row.owner && row.dueDate && row.status && row.condition)).length;
  return {
    formatVersion: 1,
    protocolId: "action-item-extraction-v1",
    runId: run.runId,
    transcriptId: run.transcriptId,
    tuple: {
      candidateCount: candidateItems.length,
      goldCount: goldItems.length,
      matchedCount: paired.length,
      precision,
      recall,
      f1: tupleF1,
    },
    fieldAccuracy: {
      owner: average(fieldRows.map((row) => Number(row.owner))),
      action: average(fieldRows.map((row) => Number(row.action))),
      dueDate: average(fieldRows.map((row) => Number(row.dueDate))),
      status: average(fieldRows.map((row) => Number(row.status))),
      condition: average(fieldRows.map((row) => Number(row.condition))),
      criticality: average(fieldRows.map((row) => Number(row.criticality))),
    },
    resolution: {
      eligible: resolutionGold.length,
      correct: resolutionCorrect,
      rate: resolutionGold.length === 0 ? 1 : resolutionCorrect / resolutionGold.length,
    },
    unsupportedCommitments: unsupportedIndexes.length,
    unsupportedCriticalActions: unsupportedCritical.length,
    unsupportedCandidateIndexes: unsupportedIndexes,
    schema: { valid: schemaErrors.length === 0, errors: schemaErrors },
    duplicates,
    sourceGrounding: {
      matchedItems: fieldRows.length,
      groundedItems: fieldRows.filter((row) => row.grounded).length,
      rate: fieldRows.length === 0 ? 0 : fieldRows.filter((row) => row.grounded).length / fieldRows.length,
    },
    matches: fieldRows,
    blindedReview: {
      usefulness: null,
      clarity: null,
      availabilityReason: "planned for confirmation; not collected in excluded feasibility work",
    },
  };
}

export function evaluateFiles({ ledgerPath, goldPath, transcriptPath, run }) {
  return evaluateLedger({
    ledger: JSON.parse(readFileSync(ledgerPath, "utf8")),
    gold: JSON.parse(readFileSync(goldPath, "utf8")),
    transcript: readFileSync(transcriptPath, "utf8"),
    run,
  });
}
