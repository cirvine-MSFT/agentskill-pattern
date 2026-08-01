const configurations = [
  {
    runId: "PILOT-ACTION-V3-A4-2F6C",
    transcriptId: "v3-pilot-ember-identity-rollout",
    category: "identity-rollout",
    meeting: "Ember identity rollout checkpoint",
    project: "Ember workforce identity rollout",
    milestone: "tenant enablement",
    dates: ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13"],
    people: ["Mira Patel", "Theo Grant", "Leah Kim", "Oscar Reed", "Nina Alvarez", "Ben Ito", "Carmen Wells", "Drew Singh"],
    artifacts: ["rollback guide", "entitlement matrix", "sign-in alert pack", "help-desk bulletin", "privileged-role review", "regional activation sheet"],
  },
  {
    runId: "PILOT-ACTION-V3-A4-71D9",
    transcriptId: "v3-pilot-harbor-billing-migration",
    category: "billing-migration",
    meeting: "Harbor billing migration checkpoint",
    project: "Harbor subscription billing migration",
    milestone: "invoice cutover",
    dates: ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27"],
    people: ["Rosa Chen", "Miles Carter", "Aisha Bell", "Grant Ellis", "Sana Malik", "Leo Park", "Tessa Morgan", "Vik Rao"],
    artifacts: ["reversal playbook", "account mapping", "charge anomaly alerts", "customer notice", "tax-control review", "market readiness grid"],
  },
  {
    runId: "PILOT-ACTION-V3-A4-C845",
    transcriptId: "v3-pilot-lumen-device-recovery",
    category: "device-recovery",
    meeting: "Lumen device recovery checkpoint",
    project: "Lumen managed-device recovery service",
    milestone: "recovery launch",
    dates: ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10"],
    people: ["Iris Novak", "Jonas Blake", "Mae Okafor", "Pavel Cruz", "Zoe Hart", "Kenji Sato", "Lena Price", "Arun Bose"],
    artifacts: ["restore runbook", "device coverage table", "recovery health alerts", "support handoff", "credential escrow review", "country recovery checklist"],
  },
];

function buildFixture(config) {
  const [lead, engineer, analyst, operator, security, support, counsel, program] = config.people;
  const [runbook, matrix, alerts, bulletin, review, checklist] = config.artifacts;
  const [d1, d2, d3, d4, d5, d6, d7] = config.dates;
  const rows = [];
  const labels = new Map();
  const add = (label, speaker, text) => {
    rows.push({ speaker, text });
    if (label) labels.set(label, rows.length);
  };

  add(null, lead, `Welcome to the ${config.meeting}. We need final owners, but the conversation will include context and rejected ideas.`);
  add(null, program, `Older notes for the ${config.project} are background only and must not be treated as assignments.`);
  add(null, analyst, "The dashboard contains a partial weekend and an internal test cohort, so its trend is descriptive.");
  add(null, operator, "Yesterday's incident bridge is closed. Completed incident work is not a new action from this meeting.");
  add("suggestion", support, `It might be useful to add screenshots to the ${bulletin}, but I am only suggesting it.`);
  add(null, counsel, "A preference or suggestion remains outside the ledger until somebody makes a definite commitment.");
  add("direct-lead", lead, `I will publish the final ${runbook} by ${d1}.`);
  add(null, engineer, `The ${runbook} should identify the normal rollback boundary and the existing escalation room.`);
  add("negation", engineer, "I will not rebuild the retired simulator, and that work has no owner.");
  add("direct-analyst", analyst, `I will reconcile the ${matrix} with the approved scope by ${d2}.`);
  add(null, program, "Approved scope means the signed appendix, not the working spreadsheet attached to the calendar.");
  add("date-original", operator, `I will configure the ${alerts} by ${d3}.`);
  add(null, operator, "The alert names need to preserve the current pager-search abbreviations.");
  add("conditional", security, `I will approve the security exception by ${d4} only if the independent retest is green; until then it is conditional.`);
  add(null, counsel, "A green retest requires the signed assessment, not a chat message from the vendor.");
  add("owner-original", support, `I will draft the ${bulletin} by ${d3}.`);
  add(null, support, "I can still answer terminology questions later even if delivery ownership changes.");
  add("blocked", engineer, `I will package the ${config.milestone} build by ${d5}; this is blocked until the signing service is restored.`);
  add(null, operator, "The signing-service incident already has an owner outside this meeting, so do not create a duplicate task.");
  add("no-date", program, "I will record the final go/no-go decision and distribute the signed decision record; there is no fixed due date.");
  add(null, counsel, "The recorded decision does not assign every idea discussed before it.");
  add("critical", security, `I will complete the launch-blocking ${review} by ${d5}.`);
  add(null, lead, "Launch-blocking is explicit for that review, so it is critical rather than merely urgent.");
  add("team", operator, `Service Operations will verify the overnight escalation roster by ${d6}.`);
  add(null, operator, "Service Operations is the canonical owner even if the individual on-call engineer changes.");
  add("rescinded-original", support, `I will schedule a broad training session by ${d6}.`);
  add(null, analyst, "The word Friday on the chart labels the sample window and is not an action due date.");
  add("date-change", operator, `Correction: move my ${alerts} due date from ${d3} to ${d5}; I remain the owner.`);
  add(null, lead, "The corrected alert date supersedes the earlier date.");
  add("rescission", support, "I withdraw the training-session commitment completely; omit it and assign no replacement.");
  add(null, counsel, "A possible training session next quarter does not revive the withdrawn commitment.");
  add("reassignment", counsel, `${counsel} will own the ${bulletin} instead of ${support}, keeping the due date ${d3}; ${support} is released.`);
  add(null, support, "Confirmed: I am released from delivery and remain available only for questions.");
  add("direct-archive", analyst, `I will archive the reconciled evidence bundle by ${d7}.`);
  add(null, analyst, "That bundle is separate from the already archived prototype evidence.");
  add("decision-only", program, "We decided to keep one launch channel. This is a decision only; channel setup is not assigned.");
  add("customer-critical", support, `I will publish the customer-blocking escalation matrix by ${d6}.`);
  add(null, support, "The escalation matrix is explicitly customer-blocking because support coverage is a launch prerequisite.");
  add("ambiguous", engineer, "I can probably handle the fallback review soon, but I am not confirming ownership or a deadline.");
  add(null, lead, "Treat the fallback-review statement as ambiguity, not as an action item.");
  add("direct-program", program, `I will circulate the final ownership table by ${d7}.`);
  add(null, counsel, "The ownership table must show the reassignment and exclude the withdrawn training session.");
  add(null, operator, "Nobody should create a second pager rotation; the existing roster remains authoritative.");
  add(null, security, "If the retest fails, the exception stays conditional and is not silently approved.");
  add("conditional-second", lead, `I will authorize ${config.milestone} only after the critical ${review} closes, with a target of ${d7}.`);
  add(null, lead, "That authorization remains conditional even if the package arrives early.");
  add("distractor", program, "The old prototype checklist was completed last month and appears here only as a distractor.");
  add(null, lead, "Final recap: retain explicit commitments with their latest owners, dates, conditions, and statuses.");
  add(null, program, "This transcript is the complete experimental meeting record; side documents are not evidence.");

  const lineId = (line) => `[${String(line).padStart(3, "0")}]`;
  const transcriptLine = (line) => `${lineId(line)} ${rows[line - 1].speaker}: ${rows[line - 1].text}`;
  const citation = (label) => {
    const line = labels.get(label);
    return { startLineId: lineId(line), endLineId: lineId(line), quote: transcriptLine(line) };
  };
  const citations = (...names) => names.map(citation);
  const expectedItems = [
    { owner: lead, action: `publish the final ${runbook}`, dueDate: d1, status: "open", condition: null, sourceCitations: citations("direct-lead"), criticality: "normal", resolutionTags: ["direct"] },
    { owner: analyst, action: `reconcile the ${matrix} with the approved scope`, dueDate: d2, status: "open", condition: null, sourceCitations: citations("direct-analyst"), criticality: "normal", resolutionTags: ["direct"] },
    { owner: operator, action: `configure the ${alerts}`, dueDate: d5, status: "open", condition: null, sourceCitations: citations("date-original", "date-change"), criticality: "normal", resolutionTags: ["date-change", "retained-owner"] },
    { owner: security, action: "approve the security exception", dueDate: d4, status: "conditional", condition: "only if the independent retest is green", sourceCitations: citations("conditional"), criticality: "normal", resolutionTags: ["conditional"] },
    { owner: counsel, action: `draft the ${bulletin}`, dueDate: d3, status: "open", condition: null, sourceCitations: citations("owner-original", "reassignment"), criticality: "normal", resolutionTags: ["reassignment"] },
    { owner: engineer, action: `package the ${config.milestone} build`, dueDate: d5, status: "blocked", condition: "until the signing service is restored", sourceCitations: citations("blocked"), criticality: "normal", resolutionTags: ["blocked"] },
    { owner: program, action: "record the final go/no-go decision and distribute the signed decision record", dueDate: null, status: "open", condition: null, sourceCitations: citations("no-date"), criticality: "normal", resolutionTags: ["explicit-no-date"] },
    { owner: security, action: `complete the launch-blocking ${review}`, dueDate: d5, status: "open", condition: null, sourceCitations: citations("critical"), criticality: "critical", resolutionTags: ["direct"] },
    { owner: "Service Operations", action: "verify the overnight escalation roster", dueDate: d6, status: "open", condition: null, sourceCitations: citations("team"), criticality: "normal", resolutionTags: ["team-owner"] },
    { owner: analyst, action: "archive the reconciled evidence bundle", dueDate: d7, status: "open", condition: null, sourceCitations: citations("direct-archive"), criticality: "normal", resolutionTags: ["direct"] },
    { owner: support, action: "publish the customer-blocking escalation matrix", dueDate: d6, status: "open", condition: null, sourceCitations: citations("customer-critical"), criticality: "critical", resolutionTags: ["direct"] },
    { owner: program, action: "circulate the final ownership table", dueDate: d7, status: "open", condition: null, sourceCitations: citations("direct-program"), criticality: "normal", resolutionTags: ["direct"] },
    { owner: lead, action: `authorize ${config.milestone}`, dueDate: d7, status: "conditional", condition: `only after the critical ${review} closes`, sourceCitations: citations("conditional-second"), criticality: "normal", resolutionTags: ["conditional"] },
  ];
  const expectedOmissions = [
    { category: "noncommitment-suggestion", sourceCitations: citations("suggestion"), canonicalPolicy: "omit", reason: "speaker explicitly labels the statement as a suggestion" },
    { category: "negation", sourceCitations: citations("negation"), canonicalPolicy: "omit", reason: "speaker refuses the work and confirms no owner" },
    { category: "rescission", owner: support, action: "schedule a broad training session", sourceCitations: citations("rescinded-original", "rescission"), canonicalPolicy: "omit", reason: "commitment is fully withdrawn without replacement" },
    { category: "decision-only", sourceCitations: citations("decision-only"), canonicalPolicy: "omit", reason: "decision has no assigned implementation action" },
    { category: "material-ambiguity", sourceCitations: citations("ambiguous"), canonicalPolicy: "ambiguity-only", reason: "speaker disclaims definite ownership and deadline" },
  ];
  return {
    ...config,
    transcript: rows.map((_, index) => transcriptLine(index + 1)).join("\n") + "\n",
    gold: {
      formatVersion: 3,
      schemaVersion: "action-ledger.gold.v3",
      protocolId: "action-item-extraction-v3",
      evaluatorOnly: true,
      transcriptId: config.transcriptId,
      ambiguityPolicy: {
        candidateBehavior: "Record materially ambiguous apparent commitments only in ambiguities.",
        scoring: "An ambiguity must cite the exact gold line range; omission from items is required.",
      },
      omissionPolicy: {
        suggestions: "omit",
        negations: "omit",
        rescindedWithoutReplacement: "omit",
        decisionsWithoutAssignedAction: "omit",
      },
      expectedItems,
      expectedOmissions,
    },
  };
}

export const fixtureSources = configurations.map(buildFixture);
