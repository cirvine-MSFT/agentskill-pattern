function pairKey(leftFactor, leftValue, rightFactor, rightValue) {
  return `${leftFactor}=${JSON.stringify(leftValue)}|${rightFactor}=${JSON.stringify(rightValue)}`;
}

function combinations(factors) {
  const entries = Object.entries(factors);
  const rows = [];
  const build = (index, row) => {
    if (index === entries.length) {
      rows.push({ ...row });
      return;
    }
    const [name, values] = entries[index];
    for (const value of values) {
      row[name] = value;
      build(index + 1, row);
    }
  };
  build(0, {});
  return rows;
}

export function requiredPairs(factors) {
  const entries = Object.entries(factors);
  const pairs = new Set();
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      for (const leftValue of entries[left][1]) {
        for (const rightValue of entries[right][1]) {
          pairs.add(pairKey(entries[left][0], leftValue, entries[right][0], rightValue));
        }
      }
    }
  }
  return pairs;
}

function coveredBy(row, names) {
  const covered = [];
  for (let left = 0; left < names.length; left += 1) {
    for (let right = left + 1; right < names.length; right += 1) {
      covered.push(pairKey(names[left], row[names[left]], names[right], row[names[right]]));
    }
  }
  return covered;
}

export function generatePairwiseCoveringArray(factors) {
  const names = Object.keys(factors);
  const candidates = combinations(factors);
  const uncovered = requiredPairs(factors);
  const selected = [];

  while (uncovered.size > 0) {
    let best = null;
    let bestCoverage = -1;
    for (const candidate of candidates) {
      const coverage = coveredBy(candidate, names).filter((pair) => uncovered.has(pair)).length;
      const serialized = JSON.stringify(candidate);
      if (coverage > bestCoverage || (coverage === bestCoverage && serialized < JSON.stringify(best))) {
        best = candidate;
        bestCoverage = coverage;
      }
    }
    if (bestCoverage <= 0) throw new Error("Unable to complete pairwise covering array.");
    selected.push(best);
    for (const pair of coveredBy(best, names)) uncovered.delete(pair);
    candidates.splice(candidates.indexOf(best), 1);
  }
  return selected;
}

export function findUncoveredPairs(rows, factors) {
  const names = Object.keys(factors);
  const uncovered = requiredPairs(factors);
  for (const row of rows) {
    for (const pair of coveredBy(row, names)) uncovered.delete(pair);
  }
  return [...uncovered];
}
