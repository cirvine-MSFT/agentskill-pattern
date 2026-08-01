# Release-note synthesis protocol foundation

**Protocol ID:** `release-note-synthesis-v0-foundation`  
**Status:** development plus excluded feasibility pilot only  
**Confirmatory status:** prohibited pending a separate merged preregistration

## 1. Falsifiable hypothesis

Release-note synthesis is a favorable Agent Skill Pattern case when one bounded public
PR/issue dossier contains enough evidence for one customer-facing draft. The target arm
should preserve grounded quality and reliability while reducing parent context and cost.
Unlike the semantic-corpus experiment, the worker must not accumulate per-fact reads,
per-item writes, repository exploration, or recursive delegation.

The experimental unit is one fresh session assigned one frozen dossier and one arm. The
artifact target is exactly one Markdown release-note draft. The parent release packet is
the immutable task envelope, one dossier identifier and hash, one output target, arm
assignment, and run identity. It does not contain evaluator facts.

## 2. Phase separation

| Phase | Readable inputs | Permitted use | Confirmation eligibility |
|---|---|---|---|
| Development | `dev-*` dossier | Deterministic and AI mechanism debugging | Never |
| Excluded pilot | `pilot-*` dossiers | One A4 run per dossier; feasibility gate only | Never |
| Main | Reserved IDs only in this PR | None until later merged preregistration | Later protocol only |

Development and pilot bytes, outputs, evaluator judgments, telemetry, and failures remain
preserved and labeled. They cannot be moved to main, retried into success, or used to
choose main thresholds after outcomes are viewed.

## 3. Frozen dossier and provenance contract

A worker-readable dossier is one canonical JSON file with:

- stable `dossierId`, partition, category, product, audience, and draft constraints;
- frozen selected fields from one or more public GitHub PRs/issues;
- repository, number, author, public URL, terminal state, merge/closure time, and merge
  commit when applicable;
- no evaluator labels, gold facts, preferred wording, quality scores, or hidden sources.

`fixtures/manifest.json` binds each dossier path, byte length, and SHA-256. Each dossier
also binds every source record with a canonical selected-field SHA-256. URLs attribute
the public material to its authors and repositories. A changed byte invalidates the
foundation until the manifest is deliberately regenerated before any affected start.

Evaluator-only atomic inventories live under `evaluator/gold/`, outside the runtime
sandbox. They define fact ID, claim, criticality, weight, category, and deterministic
support patterns. Neither parent nor worker may list, read, hash, or infer those files.

## 4. Planned arms

| Arm | Parent | Worker | Discovery/delegation |
|---|---|---|---|
| A0 | None | None | Deterministic extractive template |
| A1 | GPT-5.6 Sol | None | Inline; same two dossier tools |
| A2 | GPT-5.6 Sol | GPT-5.6 Sol | Explicit common agent |
| A3 | GPT-5.6 Sol | fixed Claude Haiku 4.5 | Explicit fixed agent |
| A4 | GPT-5.6 Sol | fixed Claude Haiku 4.5 | `release-note-synthesis` Skill discovery, then agent |

The primary contrast is A4 versus A1. Secondary contrasts are:

- A2 versus A1: delegation effect with GPT held fixed;
- A3 versus A2: worker-model effect with explicit delegation held fixed;
- A4 versus A3: Skill-discovery effect with parent, worker, and agent held fixed;
- A4 versus A2: combined model-plus-discovery target effect;
- A0 versus every AI arm: deterministic reference, not a factorial component.

No contrast may be described as isolating a factor it does not hold fixed.

## 5. Common treatment boundary

All AI arms receive byte-equivalent task semantics and the same dossier bytes. Inline A1
owns both MCP calls. Delegated workers own both MCP calls in A2-A4. For A4, the parent
must call the Skill exactly once before delegating exactly once.

The MCP surface contains only:

1. `read_release_dossier({})` — succeeds once, verifies the configured hash and size, and
   returns the complete dossier.
2. `write_release_note_draft({draft,dossierSha256})` — succeeds once after the read,
   atomically writes the final draft, and returns only `runId`, `outputPath`, and
   `integrity`.

There is no list, shell, search, web, generic read/write, validation, evaluator, or
delegation tool. The worker cannot call another agent. A rejected call is not retried.
The parent never receives dossier or draft content in delegated arms.

The launcher binds model, Skill, agent, exact task-envelope bytes/hash, configured
dossier/output paths, and tool schemas. The MCP audit binds read, write, terminal state,
bytes, hashes, and timestamps. CLI raw events bind Skill and agent lifecycle, exposed
tool schemas, calls, result bytes, and terminal completion. Exact-session usage export
binds role/model tokens, cached/reasoning tokens, nano-AIU, multiplier/credits proxy, and
timing. Missing or ambiguous evidence remains `null` with an availability reason and
fails any criterion that requires it.

## 6. Intent-to-treat and start rules

Before launch, the harness validates the dossier hash, empty output, exact task envelope,
model/profile availability, an initialized MCP `tools/list` against the agent's canonical
slash-qualified allowlist, a fixed protocol-scoped ledger, absence of every deterministic
session ID in the usage store, and writable evidence root.

- **Pre-start unavailable:** failure before a durable lifecycle marker and before process
  spawn. Record it in schedule order; it is unavailable, consumes no outcome slot, and
  may be repaired only before any outcome in that phase is inspected.
- **Started:** the durable marker is successfully created immediately before spawn.
- **Post-start:** every result, crash, timeout, refusal, malformed output, missing usage,
  boundary violation, or partial artifact is an ITT outcome. No retry or replacement.
- **Terminal success:** process terminal success, exact session identity, one valid read,
  one valid write, output/hash agreement, and required arm mechanism evidence.
- **Strict reliability:** terminal success plus valid draft and all telemetry required by
  the preregistered analysis.
- **Operational reliability:** terminal success and valid artifact regardless of semantic
  score.
- **Adherence reliability:** exact assigned models, actors, Skill/delegation path, tools,
  one read, one write, no forbidden tool, and compact return.

Any uncertainty is failure-shaped. The harness must not synthesize success metadata.

## 7. Outcomes

### Grounded quality

- claim factual precision;
- critical fact recall and weighted fact recall;
- category correctness;
- unsupported claims, separately unsupported critical claims;
- audience-inappropriate implementation details;
- broken, missing, or unrecognized references;
- blinded usefulness, clarity, and concision ratings.

Deterministic evaluation treats each non-heading, non-reference draft statement as a
claim and matches evaluator-only support patterns. It is a reproducible screening
measure, not a substitute for blinded adjudication. Human judges receive anonymized
drafts in randomized order without arm, model, telemetry, source author, or run status.

### Reliability and resources

- strict, operational, and adherence reliability;
- parent, worker, and total input/output/cached/reasoning/model tokens;
- parent, worker, and total credits/request multipliers and nano-AIU;
- parent active, worker active, parent wait, and wall time;
- parent and worker completion counts;
- exposed tool schema count and bytes;
- tool calls and result bytes by actor and tool;
- terminal status and typed disposition.

## 8. Positive-signal rule

The later main preregistration may tighten but not relax these foundation ceilings after
main outcomes start. A4 is positive versus A1 only when all are true on the exact common
ITT set:

1. factual precision margin >= -0.02; critical recall and weighted recall margins >=
   -0.05; no unsupported critical claims in A4; category correctness and reference
   validity are noninferior by -0.05;
2. strict, operational, and adherence reliability margins are each >= -0.05, with A4
   operational reliability >= 0.95;
3. A4 parent cumulative input <= 75% of A1, total nano-AIU <= 90% of A1, and total
   credits <= 90% of A1;
4. A4 total model tokens <= 125% of A1 and median wall time <= 125% of A1;
5. no A4 run exceeds 20,000 total model tokens, 300 seconds wall time, two MCP calls, or
   one successful draft write.

Failure of any conjunct means no positive signal. Secondary outcomes cannot rescue it.

## 9. Leakage controls

- The excluded pilot was intended to use one dossier and an otherwise evaluator-free
  workspace, but the captured execution used the repository root. That failure is
  preserved as a gate ambiguity and contributes to the frozen NO-GO.
- Hardened future launch code materializes only the Skill, fixed agent, and MCP service
  into an evaluator-free workspace and copies one hash-checked dossier into a confined
  contract directory. It does not retroactively repair the pilot.
- Main execution additionally requires an OS-enforced container, restricted mount, VM,
  or dedicated ACL identity that denies repository, evaluator, sibling, and prior-output
  roots. The later preregistration must bind that attestation.
- Parent and worker tool allowlists are arm-specific and closed.
- Gold facts, support patterns, scores, pilot summaries, and main reservations are absent
  from the model-readable root.
- Dossier IDs reveal partition/category only as already required by the task; run IDs do
  not encode gold outcomes.
- Evaluator runs only after terminal collection and never writes into model staging.
- Logs are scanned for evaluator paths/fact IDs and cross-dossier URLs.

## 10. Frozen excluded-pilot gate

Only A4 runs, once, on `pilot-feature-repo-delete`, `pilot-bugfix-rest-errors`, and
`pilot-mixed-repo-create`. Go requires all of:

- boundaries observable for model, Skill, delegation, task hash, calls, bytes, terminal,
  usage, timing, and disposition;
- A4 operational success 3/3 and treatment adherence 3/3;
- zero unsupported critical claims;
- exactly one bounded dossier read and one direct draft write per run;
- no unresolved protocol, tool, sandbox, telemetry, or evaluator ambiguity.

The gate was frozen before execution and produced `NO-GO`: 0/3 operational successes,
zero MCP reads/writes, no draft artifacts, and all three runs above the 20,000-token cap.
Post-run review also found rejected worker tool allowlist names, compact-return leakage,
and absent evaluator-filesystem isolation. Preserve these outcomes and do not tune, retry,
repair, or relabel them into success. Pilot quality was unscorable and resource outcomes
are descriptive only; all pilot data are excluded from confirmation.

## 11. Confirmatory preregistration boundary

Main runs are forbidden until a separate PR is merged that freezes:

- main dossier source snapshots and hashes, eligibility, sample size, IDs, and order;
- exact common and arm prompts, task envelopes, models, profiles, CLI/runtime pins,
  sandbox identity/mount policy, schemas, and tool bytes;
- pre/post-start, ITT, timeout, unavailable, retry, and closure rules;
- blinded judging assignment, rubrics, adjudication, deterministic evaluator version;
- exact outcome formulas, noninferiority margins, cost/latency/token thresholds,
  exclusions, missingness, analysis, multiplicity, and reporting;
- immutable source/evaluator pins and a closed start index.

This foundation and its pilot evidence cannot authorize or silently become that study.
