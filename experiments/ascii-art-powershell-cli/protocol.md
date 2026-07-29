# Preregistered protocol

## Identity and immutable references

- Protocol ID: `ascii-art-powershell-cli-v1`
- Preregistration version: `1.0.0`
- Registration date: 2026-07-28
- Repository: `cirvine-MSFT/agentskill-pattern`
- Repository starting commit: `71635d9f6ba1e54e81e9f1f3eb081e51187e66bd`
- All file hashes below use SHA-256 over bytes after canonical CRLF-to-LF normalization for registered text extensions (`sha256-normalized-lf-v1`); binary bytes are unchanged.
- Prompt SHA-256: `b9f218b8d744803c30aad7f52dee06eaa10d2fce2191668b54b0be02faff02e3`.
- Fixture-lock SHA-256: `929f1b04f0c646241d975c719ff3e59671319b578028016508e87110123b3613`; every measured workspace is created from files matching `fixture/fixture-lock.json`.
- Acceptance-lock SHA-256: `5be6158fcccc345b175c65373a35009e167f72fe7c90a6f5856f509979647011`.
- Randomization SHA-256: `17b872a454c9141fef73b6be939b6226c3b54ec7efac72c56e7fd4a1d4447ba0`.
- Judge-assignment SHA-256: `6e9080eb0d83254aa2dadfbda544eaf8657f5fa3843a4bb57aea9cebdc2d36c8`.
- Schedule seed: decimal `20260728`, algorithm `mulberry32-v1`.
- Judge-assignment seed: decimal `560045`, algorithm `mulberry32-v1`.
- Parent model: `gpt-5.6-sol`.
- Banner specialist model in treatment only: `claude-haiku-4.5`.
- Blinded judge model: `gpt-5.6-sol`.
- Copilot CLI protocol target: `1.0.71`; the actual version and host image must be recorded per run.
- Optional Pester version: exactly `5.7.1`. Preflight uses it only when already installed. The normative measured-session test path is the repository-owned dependency-free PowerShell assertion runner.

After registration, changes require a new versioned directory and protocol ID. Existing prompts, fixture lock, acceptance tests, seeds, conditions, metrics, hypotheses, exclusions, and analysis must not be edited. Corrections are appended to a dated deviation log in the new version, never silently rewritten.

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

The coordinator records the exact injected instruction. The validator requires byte-exact equality with the instruction registered for the scheduled condition. The requested and observed parent model must both be `gpt-5.6-sol`; the requested and observed treatment specialist model must both be `claude-haiku-4.5`. A mismatch is valid only when the attempt is excluded before outcomes are opened with exclusion reason `wrong_model`; otherwise validation fails. Treatment is noncompliant if the specialist edits anything except the specified asset, if more than one specialist is used, or if the parent delegates non-banner work. Control is noncompliant if any nested session is created.

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
6. externally interrupted session or unavailable required platform tool.

Ordinary implementation failures, timeouts after work begins, bad banners, test failures, voluntary early completion, and condition noncompliance remain intent-to-treat outcomes. Noncompliance is flagged from routing/file evidence and omitted only from the per-protocol sensitivity set. An excluded observation is retried once at the next unused retry slot with a new session/workspace and the same prompt, repetition, condition, and coordinator. Attempt 1 uses run ID suffix `-A1`; its retry uses `-A2`. Both records remain and are joined only by schedule ID plus explicit retry links. Analysis selects the sole non-excluded attempt for each schedule ID and retains excluded attempts for the flow/missingness report. A second infrastructure failure is reported missing; no further retries. Exclusions and compliance are decided from routing/manifests before deterministic or judge outcomes are opened. Report intent-to-treat (all started valid assignments) and per-protocol sensitivity sets.

## Telemetry

Store source-faithful values plus availability metadata; never infer a missing field from another metric. Required raw fields are defined by `schemas/raw-telemetry.schema.json`:

- total session AI credits and raw nano-AIU-equivalent;
- per-model credits, nano-AIU-equivalent, input tokens, output tokens, and cached tokens where exposed;
- parent cumulative input tokens, parent peak input tokens, and parent output tokens;
- specialist cumulative/peak input and output tokens (treatment), with control marked `not_applicable`;
- exposed-tool count if available, tool call count, tool result count, per-tool names/statuses/durations;
- compaction event count and compact-return byte size, each with availability metadata in addition to source-faithful event records;
- wall latency, parent active latency, specialist latency, and wait latency where available;
- routing evidence: requested model, observed model, session IDs, delegation call/result, timestamps, and raw event references.

Every metric is `{status,value,unit,source}` where status is `available`, `unavailable`, or `not_applicable`. `unavailable` requires a reason. Zero is a measured value, not a missing-data marker. Preserve raw export files unchanged and record their hashes.

## Deterministic checks

The external runner checks task behavior via the CLI process, isolated data files, exit status, JSON/text output, persistence, and negative cases. Each CLI process has a fixed 30-second timeout. On timeout the runner terminates the entire process tree and records a deterministic failed timeout assertion; a timeout after work begins is not an unavailable result. Text-output checks compare stdout with the full normalized banner asset content rather than accepting the required token alone. `validate-art.js` checks the exact asset path, UTF-8/ASCII-only bytes, line endings, line count, width bounds, allowed character class, required literal token, forbidden trailing whitespace, and final newline. It also scans the workspace for unexpected extra `.txt` banner assets. Fixture-owned baseline tests must pass before materialization.

Deterministic result is pass only if every assertion in every functional, art, and tamper child group passes. A failed assertion makes its child group and the top-level result fail. An unavailable assertion makes its child group and, absent a failure elsewhere, the top-level result unavailable; every unavailable group and top-level result requires a reason. `unavailable` is missing data, never a failure or a pass, and binary analysis omits its pair without substituting zero. Record individual assertions; do not collapse missing execution into failure.

## Blinded judge design

After deterministic collection, generate anonymized bundles containing only the task prompt, terminal diff/source needed to assess it, test result, and rendered banner. Remove condition, model, session, branch, timing, token, and routing metadata. Randomize filenames and bundle order using `design/judge-assignments.json`. After the sole non-excluded run is selected, create one schema-valid runtime binding per blind ID containing its assigned block, selected `runId`, source artifact bundle SHA-256, and final blind bundle SHA-256. Judgments repeat all four binding values and are rejected if any differ, so a replaced retry or artifact bundle cannot inherit a prior judgment.

Six fresh GPT-5.6 Sol judge sessions each score one balanced block of ten primary artifacts plus one masked reliability duplicate. Validation requires exactly one judge session ID for every artifact assigned to a block and exactly six distinct IDs across the six blocks; a judgment whose block or session membership differs from its assignment is rejected. Every block's primary set contains one observation per prompt and, hidden from the judge, five observations per condition. A judge never sees paired primary observations side by side and receives no delegation information. Judge usage is excluded from all efficiency and latency metrics.

Use `rubric.md` verbatim. Judges return schema-valid JSON only. A 10% deterministic sample is duplicated across blocks under different blind IDs to estimate exact/within-one agreement; duplicates are excluded from outcome means. Judge sessions cannot edit artifacts or run implementation agents.

## Outcomes and analysis

Primary outcomes:

1. total-session raw nano-AIU-equivalent;
2. parent raw nano-AIU-equivalent;
3. parent cumulative input tokens;
4. deterministic acceptance pass;
5. blinded overall quality mean.

Secondary outcomes include all telemetry fields, six rubric dimensions, total/parent output tokens, specialist tokens, tool events, compact-return bytes, and latency.

For continuous outcomes compute each prompt-repetition treatment-minus-control pair, the mean and median paired difference, and percent change relative to control when defined. For binary pass compute condition means, paired differences, and confidence intervals in percentage points, plus discordant counts. Aggregate rubric dimensions on their 1-5 scale without treating missing judgments as zero.

Confidence intervals use a seeded nonparametric cluster bootstrap with prompts as clusters (`seed=845621`, 10,000 draws): sample exactly 10 prompt IDs with replacement and include all three within-prompt pairs for each sampled cluster. A confidence interval is unavailable unless all three pairs are available for every one of the 10 preregistered prompt clusters; each outcome reports an explicit complete/incomplete status and withholds inferential output rather than silently reducing clusters or bootstrapping incomplete clusters. Point estimates still use complete pairs and explicitly report missing pairs by condition. `--allow-incomplete` permits an intentional empty-foundation dry-run (and descriptive incomplete diagnostics), labels structural completeness explicitly, and never relaxes the complete-cluster rule. Also report prompt-level means, repetition-level results, intent-to-treat and per-protocol sensitivity, missingness by condition, and raw paired rows. No unpaired substitution, observation-level bootstrap, multiple-comparison significance claims, or post-hoc outcome switching.

The secondary telemetry table is exhaustive rather than selective: by condition it reports each observed role/model split's AI credits, nano-AIU, cumulative and peak input tokens, output tokens, and cached tokens; aggregate exposed-tool/call/result counts; per-tool call, status, duration, and result-byte summaries; compaction event counts and compact-return bytes; routing/delegation evidence counts and raw-event reference counts; and unavailable/not-applicable/missing counts. Available metrics require numeric values and nonempty sources. Unavailable metrics require null values and nonempty reasons. Not-applicable metrics require null values, source, and reason. Treatment telemetry requires one provenance-matched parent split and one provenance-matched specialist split; control requires exactly one parent split and no specialist split.

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
