# Excluded feasibility protocol: grounded action-item extraction

## Question

Can a Skill-discovered GPT-5.6 Sol parent delegate one long synthetic meeting
transcript to a fixed Claude Haiku 4.5 worker that reads the transcript once,
writes one grounded structured ledger once, and returns only compact status,
without exposing transcript or ledger content to the parent?

The deterministic extractor is a floor because commitments, rescissions,
reassignments, date changes, conditions, ambiguity, and non-commitment
suggestions require semantic resolution.

## Later confirmatory arms

| Arm | Condition | Purpose |
| --- | --- | --- |
| A0 | Deterministic extractor | Non-model floor |
| A1 | GPT-5.6 Sol inline | Primary comparator |
| A2 | GPT-5.6 Sol parent to GPT-5.6 Sol agent | Delegation contrast |
| A3 | Explicit GPT-5.6 Sol parent to fixed Haiku | Worker-model contrast |
| A4 | Skill-discovered GPT-5.6 Sol parent to fixed Haiku | Target |

The primary contrast is A4 versus A1. Secondary contrasts A2 versus A1, A3
versus A2, and A4 versus A3 isolate delegation, model tier, and Skill routing.
No confirmatory unit is authorized by this excluded pilot.

## Input partitions

The synthetic development transcript and three distinct excluded-pilot
transcripts are each below 18,000 UTF-8 bytes. Each includes explicit
commitments, suggestions without commitment, negation, rescission or
reassignment, changed dates, conditional work, ambiguous statements, decisions
without actions, and distractor discussion.

Gold is evaluator-only. Candidate workspaces contain no gold, prior outputs,
evaluator code, repository checkout, credentials, or main inputs.

## Ledger schema and policy

The worker emits `action-ledger.v1` JSON:

```json
{
  "schemaVersion": "action-ledger.v1",
  "runId": "string",
  "transcriptId": "string",
  "items": [
    {
      "itemId": "AI-001",
      "owner": "canonical person or team",
      "action": "normalized action",
      "dueDate": "YYYY-MM-DD or null",
      "status": "open|conditional|blocked",
      "condition": "string or null",
      "sourceSpans": [
        {
          "startLine": 1,
          "endLine": 1,
          "quote": "verbatim transcript text"
        }
      ],
      "criticality": "critical|normal"
    }
  ],
  "ambiguities": [
    {
      "sourceLine": 1,
      "note": "why an apparent action was omitted or qualified"
    }
  ]
}
```

Include only a final, explicit commitment with an attributable owner. Apply the
last explicit owner, due date, status, and condition. Omit suggestions,
brainstorming, decisions without an assigned action, negated work, and fully
rescinded items. Record materially ambiguous apparent commitments in
`ambiguities`; do not invent an owner, date, condition, or action. Use `null`
only when the commitment is explicit and the due date or condition is genuinely
unstated. A critical item is one explicitly described as launch-, security-,
legal-, compliance-, outage-, or customer-blocking.

## Objective scoring

Evaluator matching is deterministic and one-to-one. Candidate/gold tuples are
eligible when canonical owners match and normalized action token F1 is at least
0.55; maximum action similarity breaks ties. Tuple precision, recall, and F1
use eligible matches. Field accuracy covers owner, normalized action (token F1
at least 0.80), final due date, status, and condition. Separate rates cover
rescission/reassignment resolution, unsupported commitments, schema validity,
duplicate tuples, and source grounding. A source span is grounded only when its
quoted text appears verbatim on the declared transcript line range.

Confirmation will additionally use blinded usefulness and clarity ratings.
They are planned but deliberately not collected in this excluded pilot.

## Frozen smoke and abandonment rule

`DEV-ACTION-V1-A4-01` is permanently excluded and consumed at first lifecycle
marker. The exact gate is `design/development-gate.json`. It requires:

- zero unknown-tool warnings;
- exactly one Skill invocation and one fixed-Haiku delegation;
- exactly one worker-owned structured `read` of the transcript and one
  worker-owned `edit` of the ledger;
- zero parent transcript reads or ledger writes;
- valid gold-independent schema and compact status;
- no access to evaluator, prior-output, or repository roots;
- only expected actors;
- at most 40,000 total model tokens and 180 seconds wall time.

Any failure permanently fires abandonment. Preserve the failure, do not retry
or tune the consumed ID, do not start a pilot or main unit, and publish NO-GO.

## Excluded pilot gate

Only after a passing smoke may the runner freeze three new pilot IDs and start
each exactly once. GO requires:

- operational and treatment-adherent 3/3;
- exact one-read/one-write 3/3;
- zero unsupported critical actions;
- valid schema, compact return, and isolation checks 3/3;
- mean tuple F1 at least 0.85 and every run at least 0.75;
- every run at most 40,000 total model tokens and 180 seconds wall time.

All starts and failures are immutable. No retries are permitted.
