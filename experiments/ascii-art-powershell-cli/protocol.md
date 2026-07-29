# Preregistered protocol

## Identity and immutable references

- Protocol ID: `ascii-art-powershell-cli-v1`
- Preregistration version: `1.0.1`
- Registration date: 2026-07-28
- Repository: `cirvine-MSFT/agentskill-pattern`
- Repository starting commit: `71635d9f6ba1e54e81e9f1f3eb081e51187e66bd`
- All file hashes below use SHA-256 over bytes after canonical CRLF-to-LF normalization for registered text extensions (`sha256-normalized-lf-v1`); binary bytes are unchanged.
- Prompt SHA-256: `b9f218b8d744803c30aad7f52dee06eaa10d2fce2191668b54b0be02faff02e3`.
- Condition/model constants SHA-256: `3e0e6d764fd4952fea0fb5a6a35eed04b40dc1adffc7363394f387679aca4396`.
- Fixture-lock SHA-256: `903cc7150f0305959fbdade2ceb7aa9b764537f1fa16804a72e0465d2550c183`; every measured workspace is created from files matching `fixture/fixture-lock.json`.
- Acceptance-lock SHA-256: `a006a176143bad1b4b7b679c1ade4496f1aa5459bd00b54b6200584b2260b8f7`.
- Randomization SHA-256: `17b872a454c9141fef73b6be939b6226c3b54ec7efac72c56e7fd4a1d4447ba0`.
- Judge-assignment SHA-256: `094c0fb07b5cff25f3229cb4996ac058d9355a313f4022ddbef4245e67f7715b`.
- Schedule seed: decimal `20260728`, algorithm `mulberry32-v1`.
- Judge-assignment seed: decimal `560045`, algorithm `mulberry32-v1`.
- Parent model: `gpt-5.6-sol`.
- Banner specialist model in treatment only: `claude-haiku-4.5`.
- Blinded judge model: `gpt-5.6-sol`.
- Copilot CLI protocol target: `1.0.71`; the actual version and host image must be recorded per run.
- Optional Pester version: exactly `5.7.1`. Preflight uses it only when already installed. The normative measured-session test path is the repository-owned dependency-free PowerShell assertion runner.

Version 1.0.1 is a pre-execution integrity amendment made while this preregistration PR remained unmerged and before any observation or judge session ran. It binds exact models/instructions, retry-selected judge artifacts, missing-data semantics, telemetry invariants, and acceptance anti-spoofing. After this version is merged, changes require a new versioned directory and protocol ID. Existing prompts, fixture lock, acceptance tests, seeds, conditions, metrics, hypotheses, exclusions, and analysis must not be edited. Corrections are appended to a dated deviation log in the new version, never silently rewritten.

## Questions and hypotheses

The experiment estimates the effect of delegating a small, separable banner asset while the parent retains the larger implementation.

- **H1 (efficiency):** treatment reduces parent raw nano-AIU-equivalent consumption and parent output tokens.
- **H2 (context):** treatment reduces parent cumulative input tokens and parent peak input tokens.
- **H3 (quality non-inferiority):** treatment deterministic pass rate and blinded functional score are no worse than control by more than the preregistered materiality margins.
- **H4 (art quality):** treatment improves blinded recognizability or composition without reducing integration or cleanliness.
- **H5 (system cost):** any parent savings may be offset by specialist credits/tokens, tool overhead, compact-return bytes, routing, or latency; total-session consumption is therefore primary alongside parent-only consumption.

No directional claim is made for total latency.

## Experimental unit and design

An observation is one fresh parent session working from a newly materialized, hash-verified copy of `fixture/`. The design is paired by prompt and repetition: 10 prompts x 3 repetitions x 2 conditions = 60 observations. A pair contains the control and treatment observations for the same prompt and repetition.

`design/randomization.json` contains six execution blocks of ten observations. Each prompt appears once per block. Blocks 1-2 form repetition 1, 3-4 repetition 2, and 5-6 repetition 3. Within each two-block repetition, each prompt receives control once and treatment once. Every block contains five observations per condition. Prompt order and complementary condition allocation are produced from the committed seed. Execute blocks and positions in order; do not optimize ordering after seeing outcomes.

## Exact conditions

Both conditions receive the same prompt object from `prompts.json`, the same fixture bytes, tools, parent model, runtime limits, acceptance opacity, and completion instruction.

**Control coordinator instruction:** "Complete the task yourself. Do not create or use nested sessions. Inspect and edit the fixture, create the required banner asset, and run repository-owned tests."

**Treatment coordinator instruction:** "Complete the implementation and testing yourself. Delegate only creation of the required banner asset to one fresh nested session using model `claude-haiku-4.5`; instruct it to write that one asset directly into the workspace. Do not delegate code, tests, inspection, integration, or any other work. Wait for the nested session and then inspect/integrate its asset."

The coordinator records the exact injected instruction. Treatment is noncompliant if the specialist edits anything except the specified asset, if more than one specialist is used, or if the parent delegates non-banner work. Control is noncompliant if any nested session is created.

`design/conditions.json` is the machine-readable authority for the exact instructions and requested/observed model IDs. An instruction mismatch is excluded as `condition_mismatch`; a requested or observed model mismatch is excluded as `wrong_model`. Unflagged mismatches invalidate dataset validation.

## Fresh-session and workspace rules

Each observation uses a never-before-used parent session ID, a new branch or detached workspace, empty conversation history, and no inherited compaction/memory. Materialize only `fixture/` into the candidate workspace; do not expose `acceptance/`, other prompts, schedules, condition labels, or prior outputs. Verify the fixture lock before the first user turn. Set a unique data/temp directory. No observation branch is merged into another trial branch or into the benchmark source. Collect output by exact parent session ID and terminal commit SHA.

The parent may edit fixture source, fixture-owned tests, and its requested asset, but scoring uses the external acceptance checkout at the registered benchmark commit. Candidate edits to fixture-owned tests cannot alter acceptance. The collector rejects acceptance files copied into or modified by a candidate workspace.

## Orchestration contract

The hierarchy is fixed:

```text
root experiment session
└── 10 case coordinator sessions (P01-P10)
    └── 6 fresh parent observation sessions per coordinator
        └── exactly 1 banner specialist session for treatment; none for control
```

The root assigns schedule entries to the matching case coordinator. A coordinator creates observations in schedule order and returns:

- protocol ID, unique run ID (`<scheduleId>-A<attempt>`), schedule ID, prompt ID, repetition, condition, attempt, and execution block/position;
- coordinator session ID, parent session ID, and treatment specialist session ID or explicit `not_applicable`;
- source benchmark commit SHA, fixture-lock SHA-256, prompt-file SHA-256, initial workspace tree SHA, terminal observation commit SHA, and artifact bundle SHA-256;
- exact branch/workspace identifier, start/end timestamps, completion state, and exclusion/retry linkage;
- paths to immutable run manifest, telemetry, artifact manifest, and deterministic result.

Collection keys each attempt by run ID, queries telemetry by exact parent/specialist session ID, and retrieves code/artifacts from the exact terminal commit SHA. Branch names, latest commits, conversation labels, or timestamps alone are never collection keys. The root verifies uniqueness and completeness before judging. Trial branches are never merged.

## Exclusions and retries

Exclude before outcome analysis only for:

1. platform/session creation failure before the parent receives the prompt;
2. fixture or prompt hash mismatch;
3. wrong parent model or, in treatment, wrong specialist model;
4. contaminated/non-fresh session;
5. missing telemetry caused by collection infrastructure failure;
6. condition instruction mismatch;
7. externally interrupted session or unavailable required platform tool.

Ordinary implementation failures, timeouts after work begins, bad banners, test failures, voluntary early completion, and condition noncompliance remain intent-to-treat outcomes. Noncompliance is flagged from routing/file evidence and omitted only from the per-protocol sensitivity set. An excluded observation is retried once at the next unused retry slot with a new session/workspace and the same prompt, repetition, condition, and coordinator. Attempt 1 uses run ID suffix `-A1`; its retry uses `-A2`. Both records remain and are joined only by schedule ID plus explicit retry links. Analysis selects the sole non-excluded attempt for each schedule ID and retains excluded attempts for the flow/missingness report. A second infrastructure failure is reported missing; no further retries. Exclusions and compliance are decided from routing/manifests before deterministic or judge outcomes are opened. Report intent-to-treat (all started valid assignments) and per-protocol sensitivity sets.

## Telemetry

Store source-faithful values plus availability metadata; never infer a missing field from another metric. Required raw fields are defined by `schemas/raw-telemetry.schema.json`:

- total session AI credits and raw nano-AIU-equivalent;
- per-model credits, nano-AIU-equivalent, input tokens, output tokens, and cached tokens where exposed;
- parent cumulative input tokens, parent peak input tokens, and parent output tokens;
- specialist cumulative/peak input and output tokens (treatment), with control marked `not_applicable`;
- exposed-tool count if available, tool call count, tool result count, per-tool names/statuses/durations;
- compact/compaction event count and returned byte size;
- wall latency, parent active latency, specialist latency, and wait latency where available;
- routing evidence: requested model, observed model, session IDs, delegation call/result, timestamps, and raw event references.

Every metric is `{status,value,unit,source,unavailableReason}` where status is `available`, `unavailable`, or `not_applicable`. `available` requires a finite numeric value and nonempty source. `unavailable` requires a null value and nonempty reason. `not_applicable` requires a null value. Zero is a measured value, not a missing-data marker. Parent model split provenance is mandatory; treatment also requires specialist split and routing provenance. Preserve raw export files unchanged and record their hashes.

## Deterministic checks

The external runner checks task behavior via the CLI process, isolated data files, exit status, JSON/text output, persistence, and negative cases. Each CLI process has a fixed 30-second timeout; timeout kills the full descendant process tree and records exit 124 as failure. Text banner checks require the asset's exact consecutive lines in stdout, preventing token-only spoofing. `validate-art.js` checks the exact asset path, UTF-8/ASCII-only bytes, line endings, line count, width bounds, allowed character class, required literal token, forbidden trailing whitespace, and final newline. It also scans the workspace for unexpected extra `.txt` banner assets. Fixture-owned baseline tests must pass before materialization.

Deterministic result is `pass` only if functional, art, and tamper groups all pass; it is `unavailable` if any group is unavailable, otherwise `fail` if any group fails. Record individual assertions. Analysis treats unavailable as missing, never as failure.

## Blinded judge design

After deterministic collection and retry selection, materialize `schemas/judge-assignment.schema.json` assignments and `schemas/judge-bundle.schema.json` anonymized bundles. Every assignment, bundle, and judgment binds the blind ID to the selected non-excluded `runId`, source artifact-bundle SHA-256, and blind-bundle SHA-256. Bundles contain only the task prompt, terminal diff/source needed to assess it, test result, and rendered banner. Remove condition, model, parent/specialist session, branch, timing, token, and routing metadata. Randomize filenames and bundle order using `design/judge-assignments.json`.

Exactly six distinct fresh GPT-5.6 Sol judge session IDs are used, one per block. Each session scores one balanced block of ten primary artifacts plus one masked reliability duplicate; every judgment records and must match its assigned block/session. Every block's primary set contains one observation per prompt and, hidden from the judge, five observations per condition. A judge never sees paired primary observations side by side and receives no delegation information. Judge usage is excluded from all efficiency and latency metrics.

Use `rubric.md` verbatim. Judges return schema-valid JSON only. A 10% deterministic sample is duplicated across blocks under different blind IDs to estimate exact/within-one agreement; duplicates are excluded from outcome means. Judge sessions cannot edit artifacts or run implementation agents.

## Outcomes and analysis

Primary outcomes:

1. total-session raw nano-AIU-equivalent;
2. parent raw nano-AIU-equivalent;
3. parent cumulative input tokens;
4. deterministic acceptance pass;
5. blinded overall quality mean.

Secondary outcomes include all telemetry fields, six rubric dimensions, total/parent output tokens, specialist tokens, tool events, compact-return bytes, and latency.

For continuous outcomes compute each prompt-repetition treatment-minus-control pair, the mean and median paired difference, and percent change relative to control when defined. For binary pass compute paired difference in percentage points and discordant counts. Aggregate rubric dimensions on their 1-5 scale without treating missing judgments as zero.

Confidence intervals use a seeded nonparametric cluster bootstrap with prompts as clusters (`seed=845621`, 10,000 draws): sample 10 prompt IDs with replacement and include all three within-prompt pairs for each sampled cluster. Binary effects and intervals are percentage points. Point estimates use available complete pairs, but a bootstrap interval is unavailable unless all 10 preregistered prompt clusters each have all three pairs; the report states the incomplete-cluster reason rather than silently bootstrapping fewer clusters. Also report prompt-level means, repetition-level results, intent-to-treat and per-protocol sensitivity, missingness/unavailable counts by condition, and raw paired rows. No unpaired substitution, observation-level bootstrap, multiple-comparison significance claims, or post-hoc outcome switching.

Secondary telemetry analysis includes every top-level metric, all parent/specialist per-model credits and token fields (including cached tokens), tool result bytes and observed duration, compaction event/return sizes, routing event/delegation evidence, model mismatch counts, and per-run unavailable-field counts. Categorical routing identity is validated against the registered constants rather than averaged.

Practical materiality markers, interpreted as descriptive thresholds rather than hypothesis-test cutoffs:

| Outcome | Material improvement | Non-inferiority margin |
|---|---:|---:|
| Total raw nano-AIU-equivalent | treatment <= -10% | treatment <= +5% |
| Parent raw nano-AIU-equivalent | treatment <= -15% | treatment <= +5% |
| Parent cumulative input tokens | treatment <= -15% | treatment <= +5% |
| Wall latency | treatment <= -10% | treatment <= +15% |
| Deterministic pass rate | treatment >= +5 pp | treatment >= -5 pp |
| Overall quality | treatment >= +0.25 | treatment >= -0.25 |
| Recognizability/composition | treatment >= +0.30 | treatment >= -0.25 |

All raw measurements and intervals are reported even when no marker is crossed.

## Limitations

The benchmark covers one Windows-oriented PowerShell fixture, ten tasks, one parent model, one lightweight specialist, and a visibly separable art artifact. Results may not generalize to other languages, task coupling, agent interfaces, models, or long-lived sessions. The specialist can influence parent context through its return and file edits despite narrow delegation. Platform credit accounting and token/event exposure may change; unavailable fields reduce comparability. Judges share the parent model family and may have systematic preferences. Three repetitions estimate stochastic variation weakly, while only ten prompt clusters limit interval precision. External acceptance favors observable CLI behavior and cannot fully measure maintainability.
