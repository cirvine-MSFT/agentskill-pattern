import { readFileSync } from "node:fs";

function patterns(values) {
  return values.map((value) => new RegExp(value, "iu"));
}

function extractUrls(markdown) {
  return [...markdown.matchAll(/https:\/\/github\.com\/[^\s)>]+/gu)].map((match) =>
    match[0].replace(/[.,;:]$/u, ""));
}

function claimLines(markdown) {
  const lines = markdown.split(/\r?\n/u);
  const claims = [];
  let references = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^##\s+References\s*$/iu.test(line)) {
      references = true;
      continue;
    }
    if (/^#/u.test(line)) {
      references = false;
      continue;
    }
    if (!line || references || /^[-*]\s+https:\/\//u.test(line)) continue;
    claims.push(line.replace(/^[-*]\s+/u, ""));
  }
  return claims;
}

function atomicClaims(markdown) {
  return claimLines(markdown).flatMap((claim) =>
    claim
      .split(/(?<=[.!?])\s+|;\s+/u)
      .map((item) => item.trim())
      .filter(Boolean));
}

function categoryCorrect(markdown, category) {
  if (category === "feature") return /^##\s+(?:New|Features?)\s*$/imu.test(markdown);
  if (category === "bug-fix-set") return /^##\s+(?:Fixed|Fixes|Bug fixes?)\s*$/imu.test(markdown);
  return /^##\s+Breaking changes?\s*$/imu.test(markdown)
    && /^##\s+(?:New|Features?|Fixed|Fixes|Bug fixes?)\s*$/imu.test(markdown);
}

export function evaluateDraft({ dossier, inventory, draftBytes }) {
  const draft = draftBytes.toString("utf8");
  const claims = atomicClaims(draft);
  const factResults = inventory.facts.map((fact) => ({
    id: fact.id,
    critical: fact.critical,
    weight: fact.weight,
    recalled: patterns(fact.supportPatterns).some((pattern) => pattern.test(draft)),
  }));
  const supportedClaims = claims.filter((claim) =>
    inventory.facts.some((fact) =>
      patterns(fact.claimPatterns).some((pattern) =>
        new RegExp(`^(?:${pattern.source})[.!]?$`, "iu").test(claim))));
  const unsupportedClaims = claims.filter((claim) => !supportedClaims.includes(claim));
  const critical = factResults.filter((fact) => fact.critical);
  const recalledCritical = critical.filter((fact) => fact.recalled);
  const totalWeight = factResults.reduce((sum, fact) => sum + fact.weight, 0);
  const recalledWeight = factResults
    .filter((fact) => fact.recalled)
    .reduce((sum, fact) => sum + fact.weight, 0);
  const unsupportedCritical = patterns(inventory.unsupportedCriticalPatterns)
    .filter((pattern) => pattern.test(draft))
    .map((pattern) => pattern.source);
  const audienceInappropriate = patterns(inventory.audienceInappropriatePatterns)
    .filter((pattern) => pattern.test(draft))
    .map((pattern) => pattern.source);
  const actualReferences = [...new Set(extractUrls(draft))].sort();
  const expectedReferences = [...inventory.requiredReferences].sort();
  const missingReferences = expectedReferences.filter((url) => !actualReferences.includes(url));
  const unrecognizedReferences = actualReferences.filter((url) => !expectedReferences.includes(url));
  const words = draft.trim().split(/\s+/u).filter(Boolean).length;
  const structuralErrors = [];
  if (!/^#\s+\S/mu.test(draft)) structuralErrors.push("missing-title");
  if (!/^##\s+References\s*$/imu.test(draft)) structuralErrors.push("missing-references-heading");
  if (words > dossier.target.maxWords) structuralErrors.push("word-limit-exceeded");
  if (!categoryCorrect(draft, inventory.expectedCategory)) structuralErrors.push("category-heading-mismatch");
  return {
    formatVersion: 1,
    dossierId: dossier.dossierId,
    partition: dossier.partition,
    deterministicScreen: {
      valid: structuralErrors.length === 0,
      structuralErrors,
      claimCount: claims.length,
      supportedClaimCount: supportedClaims.length,
      unsupportedClaimCount: unsupportedClaims.length,
      unsupportedClaims,
      factualPrecision: claims.length === 0 ? 0 : supportedClaims.length / claims.length,
      criticalFactRecall: critical.length === 0 ? 1 : recalledCritical.length / critical.length,
      weightedFactRecall: totalWeight === 0 ? 1 : recalledWeight / totalWeight,
      categoryCorrect: categoryCorrect(draft, inventory.expectedCategory),
      unsupportedCriticalClaims: unsupportedCritical,
      audienceInappropriateDetails: audienceInappropriate,
      references: {
        expected: expectedReferences,
        actual: actualReferences,
        missing: missingReferences,
        unrecognized: unrecognizedReferences,
        brokenCount: missingReferences.length + unrecognizedReferences.length,
      },
      facts: factResults,
      words,
    },
    blindedRatings: {
      usefulness: null,
      clarity: null,
      concision: null,
      availabilityReason: "not collected in deterministic foundation or excluded pilot",
    },
  };
}

export function evaluateFiles(dossierPath, inventoryPath, draftPath) {
  return evaluateDraft({
    dossier: JSON.parse(readFileSync(dossierPath, "utf8")),
    inventory: JSON.parse(readFileSync(inventoryPath, "utf8")),
    draftBytes: readFileSync(draftPath),
  });
}
