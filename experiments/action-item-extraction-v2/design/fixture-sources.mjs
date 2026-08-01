const configurations = [
  {
    partition: "development",
    phase: "development-unit",
    runId: "DEV-ACTION-V2-A4-7C31",
    transcriptId: "dev-cedar-release-review",
    meeting: "Cedar release readiness",
    project: "Cedar desktop release",
    milestone: "release candidate",
    dates: ["2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08", "2026-08-10", "2026-08-11", "2026-08-12"],
    people: ["Elena Voss", "Marcus Lee", "Talia Brooks", "Ravi Desai", "Sophie Turner", "Caleb Ng", "Imani Ross", "Jon Bell"],
    artifacts: ["rollback runbook", "accessibility matrix", "installer telemetry", "support brief", "signing-key audit", "regional checklist"],
  },
  {
    partition: "excluded-pilot",
    phase: "excluded-pilot",
    runId: "PILOT-ACTION-V2-A4-19B2",
    transcriptId: "pilot-orchid-data-cutover",
    meeting: "Orchid data cutover",
    project: "Orchid warehouse migration",
    milestone: "cutover rehearsal",
    dates: ["2026-08-14", "2026-08-15", "2026-08-17", "2026-08-18", "2026-08-20", "2026-08-21", "2026-08-24"],
    people: ["Nadia Flores", "Evan Cho", "Keisha Moore", "Luis Ortega", "Bethany Shaw", "Derek Wells", "Mei Tan", "Andre Young"],
    artifacts: ["replication runbook", "row-count matrix", "lag telemetry", "analyst brief", "encryption-key audit", "region cutover checklist"],
  },
  {
    partition: "excluded-pilot",
    phase: "excluded-pilot",
    runId: "PILOT-ACTION-V2-A4-53E8",
    transcriptId: "pilot-quartz-mobile-launch",
    meeting: "Quartz mobile launch",
    project: "Quartz mobile application",
    milestone: "store submission",
    dates: ["2026-09-02", "2026-09-03", "2026-09-04", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"],
    people: ["Avery Quinn", "Mateo Ruiz", "Janelle Price", "Noah Kim", "Fatima Zahra", "Colin Webb", "Yuki Mori", "Samira Cole"],
    artifacts: ["rollback playbook", "device coverage matrix", "crash telemetry", "support launch brief", "certificate audit", "country launch checklist"],
  },
  {
    partition: "excluded-pilot",
    phase: "excluded-pilot",
    runId: "PILOT-ACTION-V2-A4-8DA4",
    transcriptId: "pilot-summit-controls-audit",
    meeting: "Summit controls audit",
    project: "Summit finance controls",
    milestone: "auditor walkthrough",
    dates: ["2026-09-16", "2026-09-17", "2026-09-18", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"],
    people: ["Greta Olsen", "Hassan Malik", "June Park", "Owen Ford", "Priyanka Shah", "Wes Carter", "Lin Zhao", "Darius King"],
    artifacts: ["exception runbook", "control coverage matrix", "evidence telemetry", "auditor brief", "credential audit", "entity controls checklist"],
  },
];

function fixture(config) {
  const [lead, engineer, analyst, operator, security, support, legal, program] = config.people;
  const [runbook, matrix, telemetry, brief, audit, checklist] = config.artifacts;
  const [d1, d2, d3, d4, d5, d6, d7] = config.dates;
  const rows = [];
  const labels = new Map();
  const add = (label, speaker, text) => {
    rows.push({ speaker, text });
    if (label) labels.set(label, rows.length);
  };

  add(null, lead, `Thanks for joining the ${config.meeting} review. Today we need final ownership, not a brainstorm recap.`);
  add(null, program, `The ${config.project} notes from last week are context only; nobody should infer assignments from those notes.`);
  add(null, analyst, `Current dashboards are stable, although the sample window still includes a holiday and one partial day.`);
  add(null, engineer, `The team completed the earlier prototype. That completed work is not part of today's action ledger.`);
  add(null, operator, `I have the agenda: readiness evidence, operational coverage, customer communication, and the final decision record.`);
  add("suggestion", support, `Maybe we should create a second ${brief} with screenshots; that is a suggestion, not a commitment.`);
  add(null, legal, `For clarity, tentative ideas should stay out of the final list unless someone explicitly owns them.`);
  add("direct-1", lead, `I will publish the final ${runbook} by ${d1}.`);
  add(null, engineer, `That runbook should include the normal rollback boundary and a link to the incident channel.`);
  add("negation", engineer, `I will not rebuild the legacy simulator, and nobody is assigned that work.`);
  add("direct-2", analyst, `I will reconcile the ${matrix} against the approved scope by ${d2}.`);
  add(null, program, `The approved scope is the signed appendix, not the unlabeled spreadsheet in the shared folder.`);
  add(null, operator, `There are two monitoring views. One is noisy during maintenance and should not be treated as a failure.`);
  add("date-original", operator, `I will configure the ${telemetry} alert set by ${d3}.`);
  add(null, support, `The alert wording matters because the overnight team uses the short label in pager search.`);
  add(null, security, `I reviewed the threat notes; the unresolved paragraph describes a historical test account, not current access.`);
  add("conditional", security, `I will approve the security exception by ${d4} only if the penetration-test retest is green; until then this item is conditional.`);
  add(null, legal, `A green retest means the signed result, not an informal message from the testing vendor.`);
  add(null, program, `Let's separate assignment changes from people volunteering to answer questions.`);
  add("owner-original", support, `I will draft the customer-facing ${brief} by ${d3}.`);
  add(null, support, `I can still answer terminology questions even if ownership changes later in this meeting.`);
  add(null, analyst, `The volume chart fell after filtering synthetic traffic. That is an observation and creates no task.`);
  add("blocked", engineer, `I will package the ${config.milestone} build by ${d5}; it is blocked until the signing service returns to service.`);
  add(null, operator, `Operations has already opened the signing incident. Do not duplicate that completed escalation as a new action.`);
  add(null, lead, `We are keeping the planned review cadence even if the build arrives early.`);
  add("no-date", program, `I will record the final launch decision and distribute the signed decision log; there is no fixed due date.`);
  add(null, legal, `The decision log records the outcome but does not itself assign every follow-up mentioned during discussion.`);
  add(null, security, `One token was seen in a test screenshot and has already been revoked. The revocation is completed context.`);
  add("critical", security, `I will complete the launch-blocking ${audit} by ${d5}.`);
  add(null, lead, `The audit is explicitly launch-blocking, so flag it as critical rather than inferring criticality from urgency.`);
  add(null, analyst, `Someone could improve the chart colors later, but there is no owner and no commitment.`);
  add("team", operator, `Release Operations will verify the overnight escalation roster by ${d6}.`);
  add(null, operator, `That team name is the accountable owner; individual on-call rotations can change without changing the action.`);
  add(null, support, `Yesterday I said I would arrange a broad training session. I am restating it now so the final status is unambiguous.`);
  add("rescinded-original", support, `I will schedule the broad training session by ${d6}.`);
  add(null, program, `Before changing that item, let's distinguish a cancellation from a date adjustment.`);
  add(null, analyst, `The chart annotation marked "Friday" refers to data collection, not an action due date.`);
  add("date-change", operator, `Correction to my ${telemetry} commitment: move its due date from ${d3} to ${d5}; I still own it.`);
  add(null, lead, `That is the final date for the telemetry work, and the earlier date is superseded.`);
  add("rescission", support, `I withdraw my training-session commitment completely; do not carry it into the ledger and no replacement owner is assigned.`);
  add(null, legal, `The withdrawn training idea may return in a later quarter, but that possibility is not a current commitment.`);
  add("reassignment", legal, `${legal} will own the customer-facing ${brief} instead of ${support}, with the same due date ${d3}; ${support} is released.`);
  add(null, support, `Confirmed: I am released from the brief, while I remain available for questions without owning delivery.`);
  add(null, engineer, `The packaging dependency is unchanged. A restored signing service is the condition, not a new assignment to Security.`);
  add("direct-10", analyst, `After the review, I will archive the reconciled evidence bundle by ${d7}.`);
  add(null, analyst, `This archive is separate from the completed prototype folder and will use the final naming convention.`);
  add("decision-only", program, `We decided to use a single launch channel. That is a decision only; nobody is assigned channel setup here.`);
  add("customer-critical", support, `I will publish the customer-blocking support escalation matrix by ${d6}.`);
  add(null, support, `Customer-blocking is explicit because launch cannot proceed without the support escalation path.`);
  add("ambiguous", engineer, `I can probably take care of the fallback review soon, though I am not saying whether that is a commitment or what "soon" means.`);
  add(null, lead, `Record that fallback-review statement as materially ambiguous, not as an action item.`);
  add("direct-12", program, `I will circulate the final ownership table by ${d7}.`);
  add(null, legal, `The ownership table should reflect the reassignment and omit the withdrawn training session.`);
  add(null, operator, `No one should create a second pager rotation; the existing roster remains authoritative.`);
  add(null, security, `If the retest fails, the exception stays conditional and does not silently become approved.`);
  add(null, lead, `Final recap: explicit commitments stand with the latest owners and dates; suggestions, negations, decisions-only, and withdrawn work are excluded.`);
  add(null, program, `This transcript is the complete meeting record for the experiment. Side conversations and prior documents are distractors.`);

  const span = (label) => {
    const line = labels.get(label);
    return [{ startLine: line, endLine: line, quote: rows[line - 1].text }];
  };
  const spans = (...names) => names.flatMap(span);
  const expectedItems = [
    { owner: lead, action: `publish the final ${runbook}`, dueDate: d1, status: "open", condition: null, sourceSpans: span("direct-1"), criticality: "normal", resolutionTags: ["direct"] },
    { owner: analyst, action: `reconcile the ${matrix} against the approved scope`, dueDate: d2, status: "open", condition: null, sourceSpans: span("direct-2"), criticality: "normal", resolutionTags: ["direct"] },
    { owner: operator, action: `configure the ${telemetry} alert set`, dueDate: d5, status: "open", condition: null, sourceSpans: spans("date-original", "date-change"), criticality: "normal", resolutionTags: ["date-change", "retained-owner"] },
    { owner: security, action: "approve the security exception", dueDate: d4, status: "conditional", condition: "only if the penetration-test retest is green", sourceSpans: span("conditional"), criticality: "critical", resolutionTags: ["conditional"] },
    { owner: legal, action: `draft the customer-facing ${brief}`, dueDate: d3, status: "open", condition: null, sourceSpans: spans("owner-original", "reassignment"), criticality: "normal", resolutionTags: ["reassignment"] },
    { owner: engineer, action: `package the ${config.milestone} build`, dueDate: d5, status: "blocked", condition: "until the signing service returns to service", sourceSpans: span("blocked"), criticality: "normal", resolutionTags: ["blocked"] },
    { owner: program, action: "record the final launch decision and distribute the signed decision log", dueDate: null, status: "open", condition: null, sourceSpans: span("no-date"), criticality: "normal", resolutionTags: ["explicit-no-date"] },
    { owner: security, action: `complete the launch-blocking ${audit}`, dueDate: d5, status: "open", condition: null, sourceSpans: span("critical"), criticality: "critical", resolutionTags: ["direct"] },
    { owner: "Release Operations", action: "verify the overnight escalation roster", dueDate: d6, status: "open", condition: null, sourceSpans: span("team"), criticality: "normal", resolutionTags: ["team-owner"] },
    { owner: analyst, action: "archive the reconciled evidence bundle", dueDate: d7, status: "open", condition: null, sourceSpans: span("direct-10"), criticality: "normal", resolutionTags: ["direct"] },
    { owner: support, action: "publish the customer-blocking support escalation matrix", dueDate: d6, status: "open", condition: null, sourceSpans: span("customer-critical"), criticality: "critical", resolutionTags: ["direct"] },
    { owner: program, action: "circulate the final ownership table", dueDate: d7, status: "open", condition: null, sourceSpans: span("direct-12"), criticality: "normal", resolutionTags: ["direct"] },
  ];
  const expectedOmissions = [
    { category: "noncommitment-suggestion", sourceSpans: span("suggestion"), reason: "suggestion explicitly disclaimed" },
    { category: "negation", sourceSpans: span("negation"), reason: "explicit refusal and no assignment" },
    { category: "rescission", owner: support, action: "schedule the broad training session", sourceSpans: spans("rescinded-original", "rescission"), reason: "commitment fully withdrawn without replacement" },
    { category: "decision-only", sourceSpans: span("decision-only"), reason: "decision has no assigned action" },
    { category: "material-ambiguity", sourceSpans: span("ambiguous"), reason: "speaker disclaims whether statement is a commitment and gives no definite date" },
  ];
  return {
    ...config,
    rows,
    transcript: rows.map((row, index) => `[${String(index + 1).padStart(3, "0")}] ${row.speaker}: ${row.text}`).join("\n") + "\n",
    gold: {
      formatVersion: 2,
      protocolId: "action-item-extraction-v2",
      evaluatorOnly: true,
      transcriptId: config.transcriptId,
      expectedItems,
      expectedOmissions,
    },
  };
}

export const fixtureSources = configurations.map(fixture);
