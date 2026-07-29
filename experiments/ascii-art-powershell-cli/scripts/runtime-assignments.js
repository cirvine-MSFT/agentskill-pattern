'use strict';

const expectedUnjudgeable = Object.freeze({
  blindId: 'B0022',
  scheduleId: 'P04-R1-control',
  runId: 'P04-R1-control-A1',
  candidatePhrase: 'control output',
  reason: 'P04-R1-control-A1 source artifact candidate content contains a prohibited high-confidence condition-revealing provenance marker at $[property:1].value[0][property:0].value.'
});

const expectedCounts = Object.freeze({
  plannedPrimary: 60,
  availablePrimary: 45,
  plannedReliabilityDuplicates: 6,
  availableReliabilityDuplicates: 4,
  plannedTotal: 66,
  availableTotal: 49
});

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assignmentRows(assignments) {
  return assignments.blocks.flatMap((block) => (
    block.artifacts.map((assignment) => ({ block: block.block, assignment }))
  ));
}

function buildExpectedRuntimeMetadata({
  assignments,
  selectedScheduleIds,
  authenticatedScheduleIds,
  sourceAssignmentsSha256
}) {
  const rows = assignmentRows(assignments);
  const primaryRows = rows.filter(({ assignment }) => !assignment.duplicateOfBlindId);
  const successfulPrimaryIds = new Set(primaryRows
    .filter(({ assignment }) => (
      selectedScheduleIds.has(assignment.scheduleId) &&
      authenticatedScheduleIds.has(assignment.scheduleId)
    ))
    .map(({ assignment }) => assignment.blindId));
  const includedIds = new Set(rows
    .filter(({ assignment }) => (
      selectedScheduleIds.has(assignment.scheduleId) &&
      authenticatedScheduleIds.has(assignment.scheduleId) &&
      (!assignment.duplicateOfBlindId ||
        successfulPrimaryIds.has(assignment.duplicateOfBlindId))
    ))
    .map(({ assignment }) => assignment.blindId));
  const runtimeAssignments = {
    ...assignments,
    blocks: assignments.blocks.map((block) => ({
      ...block,
      artifacts: block.artifacts.filter((assignment) => includedIds.has(assignment.blindId))
    }))
  };
  const missingScheduleIds = primaryRows
    .filter(({ assignment }) => !selectedScheduleIds.has(assignment.scheduleId))
    .map(({ assignment }) => assignment.scheduleId);
  const blocks = assignments.blocks.map((block) => {
    const plannedPrimary = block.artifacts.filter((item) => !item.duplicateOfBlindId);
    const plannedDuplicates = block.artifacts.filter((item) => item.duplicateOfBlindId);
    const available = runtimeAssignments.blocks
      .find((item) => item.block === block.block).artifacts;
    return {
      block: block.block,
      planned: {
        primary: plannedPrimary.length,
        reliabilityDuplicates: plannedDuplicates.length,
        total: block.artifacts.length
      },
      available: {
        primary: available.filter((item) => !item.duplicateOfBlindId).length,
        reliabilityDuplicates: available.filter((item) => item.duplicateOfBlindId).length,
        total: available.length
      },
      missingScheduleIds: plannedPrimary
        .filter((item) => !selectedScheduleIds.has(item.scheduleId))
        .map((item) => item.scheduleId),
      unjudgeableBlindIds: plannedPrimary
        .filter((item) => item.blindId === expectedUnjudgeable.blindId)
        .map((item) => item.blindId)
    };
  });
  const summary = {
    protocolId: assignments.protocolId,
    sourceAssignments: {
      path: 'design/judge-assignments.json',
      sha256: sourceAssignmentsSha256
    },
    runtimeAssignmentsPath: 'design/assignments-runtime.json',
    blindDirectory: 'artifacts/blind',
    counts: { ...expectedCounts },
    blocks,
    missingScheduleIds,
    unjudgeable: [{ ...expectedUnjudgeable }],
    designRealization: {
      preregisteredBalancedTenPrimaryDesignRealized: false,
      noReplacementOrRebalancingAfterOutcomes: true,
      reason: `${missingScheduleIds.length} planned schedules have no selected artifact after exhausted infrastructure attempts, and 1 selected artifact is unjudgeable because the frozen provenance scanner rejected its candidate content. Runtime assignments retain only successfully bound blind IDs in original block and within-block order.`
    }
  };
  return { runtimeAssignments, summary };
}

function validateRuntimeMetadata({
  assignments,
  runtimeAssignments,
  summary,
  selectedScheduleIds,
  authenticatedScheduleIds,
  observedUnjudgeable,
  sourceAssignmentsSha256,
  bindingBlindIds
}) {
  const errors = [];
  if (!same(observedUnjudgeable, [expectedUnjudgeable])) {
    errors.push('runtime metadata must record B0022 as the sole exact frozen scanner rejection');
  }
  if (!selectedScheduleIds.has(expectedUnjudgeable.scheduleId)) {
    errors.push('B0022 frozen unjudgeable artifact must be a selected run');
  }
  if (authenticatedScheduleIds.has(expectedUnjudgeable.scheduleId)) {
    errors.push('B0022 must remain rejected by the frozen provenance scanner');
  }

  const expected = buildExpectedRuntimeMetadata({
    assignments,
    selectedScheduleIds,
    authenticatedScheduleIds,
    sourceAssignmentsSha256
  });
  if (!same(runtimeAssignments, expected.runtimeAssignments)) {
    errors.push('runtime assignments must contain exactly the recorded bindings in original block and within-block order');
  }
  if (!same(summary, expected.summary)) {
    errors.push('blinding summary must exactly record the frozen runtime assignments and unjudgeable artifact');
  }

  const rows = runtimeAssignments && Array.isArray(runtimeAssignments.blocks)
    ? assignmentRows(runtimeAssignments)
    : [];
  const primary = rows.filter(({ assignment }) => !assignment.duplicateOfBlindId);
  const duplicates = rows.filter(({ assignment }) => assignment.duplicateOfBlindId);
  if (rows.length !== expectedCounts.availableTotal ||
      primary.length !== expectedCounts.availablePrimary ||
      duplicates.length !== expectedCounts.availableReliabilityDuplicates) {
    errors.push('runtime assignments must contain exactly 49 bindings: 45 primaries and 4 reliability duplicates');
  }
  const expectedBlindIds = assignmentRows(expected.runtimeAssignments)
    .map(({ assignment }) => assignment.blindId)
    .sort();
  if (bindingBlindIds && !same([...bindingBlindIds].sort(), expectedBlindIds)) {
    errors.push('blind bindings must exactly match the 49 filtered runtime assignment IDs');
  }
  return { errors, expectedAssignments: expected.runtimeAssignments, expectedSummary: expected.summary };
}

function isExpectedUnjudgeable(manifest, error, candidateText) {
  return manifest.scheduleId === expectedUnjudgeable.scheduleId &&
    manifest.runId === expectedUnjudgeable.runId &&
    error.message === expectedUnjudgeable.reason &&
    candidateText.toLowerCase().includes(expectedUnjudgeable.candidatePhrase);
}

module.exports = {
  expectedCounts,
  expectedUnjudgeable,
  isExpectedUnjudgeable,
  validateRuntimeMetadata
};
