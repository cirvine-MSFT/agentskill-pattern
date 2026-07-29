# Preregistered protocol

## Identity and immutable references

- Protocol ID: `ascii-art-powershell-cli-v1`
- Preregistration version: `1.0.2`
- Registration date: 2026-07-28
- Repository: `cirvine-MSFT/agentskill-pattern`
- Repository starting commit: `71635d9f6ba1e54e81e9f1f3eb081e51187e66bd`
- All file hashes below use SHA-256 over bytes after canonical CRLF-to-LF normalization for registered text extensions (`sha256-normalized-lf-v1`); binary bytes are unchanged.
- Prompt SHA-256: `b9f218b8d744803c30aad7f52dee06eaa10d2fce2191668b54b0be02faff02e3`.
- Fixture-lock SHA-256: `929f1b04f0c646241d975c719ff3e59671319b578028016508e87110123b3613`; every measured workspace is created from files matching `fixture/fixture-lock.json`.
- Acceptance-lock SHA-256: `58162a48495f5cd1f29fccb5fb545959f42dee2db584b0d0eea9dc19f1fc4629`.
- Randomization SHA-256: `17b872a454c9141fef73b6be939b6226c3b54ec7efac72c56e7fd4a1d4447ba0`.
- Judge-assignment SHA-256: `14f31cedff85e984e83bf947975f18aba58cf9cf872d330bafbfa1936badf9fc`.
- Schedule seed: decimal `20260728`, algorithm `mulberry32-v1`.
- Judge-assignment seed: decimal `560045`, algorithm `mulberry32-v1`.
- Parent model: `gpt-5.6-sol`.
- Banner specialist model in treatment only: `claude-haiku-4.5`.
- Blinded judge model: `gpt-5.6-sol`.
- Copilot CLI protocol target: `1.0.71`; the actual version and host image must be recorded per run. Normative execution is restricted to `Windows_NT` so acceptance can use kill-on-close Windows job objects for reliable descendant cleanup.
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

The coordinator records the exact injected instruction. The validator requires byte-exact equality with the instruction registered for the scheduled condition. The requested and observed parent model must both be `gpt-5.6-sol`; when a treatment specialist session exists, its requested and observed model must both be `claude-haiku-4.5`. A mismatch is valid only when the attempt is excluded before outcomes are opened with exclusion reason `wrong_model`; otherwise validation fails. Compliance is never accepted from a coordinator-authored boolean. The manifest records event-ID sets, and validation derives and matches those sets against exact-byte-authenticated raw delegation call/result, tool call/result, and file-change events. Treatment is noncompliant unless exactly one delegation is scoped to `create_banner_only` at the preregistered banner path and every specialist tool target and file change is that path. An observed timeout before or during delegation uses available evidence with absent/partial nullable event IDs and remains a valid intent-to-treat noncompliant observation. `unavailable` means the platform could not expose the delegation event field; such an attempt must be excluded as `telemetry_collection_failure` and retried rather than self-certified. Control is noncompliant if any delegation event exists.

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

The root assigns schedule entries to the matching case coordinator. Every attempt declares an explicit lifecycle tuple. A started parent uses `phase=session_started`, `status=included|excluded`, and `availability=evidence_required` in `run-manifest.json`. An attempt for which no parent session was created uses the dedicated `pre-execution-failure.json` shape with `phase=pre_execution`, `status=excluded`, and `availability=not_created`. A coordinator creates observations in schedule order and returns:

- protocol ID, unique run ID (`<scheduleId>-A<attempt>`), schedule ID, prompt ID, repetition, condition, attempt, and execution block/position;
- for a session-started attempt, root experiment session ID, case coordinator session ID, parent session ID, and treatment specialist session ID or explicit `not_applicable`;
- for a session-started attempt, source benchmark commit SHA, fixture-lock SHA-256, prompt-file SHA-256, initial workspace tree SHA, terminal observation commit SHA, and artifact bundle SHA-256;
- for a session-started attempt, exact branch/workspace identifier, start/end timestamps, completion state, and exclusion/retry linkage;
- for a session-started attempt, paths to immutable run manifest, telemetry, artifact manifest when available, and deterministic result;
- for a pre-execution attempt, only scheduled identity, block/position/attempt, the explicit lifecycle tuple, allowed reason, and reciprocal retry linkage in a pre-execution failure record.

Collection keys every attempt by run ID. For session-started attempts it queries telemetry by exact parent/specialist session ID and retrieves code/artifacts from the exact terminal commit SHA. A pre-execution record must not contain root, coordinator, parent, or specialist session IDs; commit/workspace references; telemetry; deterministic results; artifacts; condition evidence; or outcome/completion state. Exactly one root experiment session and one prompt-specific case coordinator per represented prompt are verified from session-started records; lifecycle failure records never fabricate those IDs. Root, case coordinator, parent, and specialist session ID sets are mutually disjoint where roles differ; judge IDs are disjoint from every started trial-session role. Branch names, latest commits, conversation labels, or timestamps alone are never collection keys. The root verifies uniqueness and completeness before judging. Trial branches are never merged.

## Exclusions and retries

Exclude before outcome analysis only for:

1. platform/session creation failure before the parent receives the prompt;
2. fixture or prompt hash mismatch;
3. wrong parent model or, in treatment, wrong specialist model;
4. contaminated/non-fresh session;
5. missing telemetry caused by collection infrastructure failure;
6. externally interrupted session or unavailable required platform tool.

Only `session_creation_failure`, a pre-session fixture/prompt `hash_mismatch`, `external_interruption`, or `required_tool_unavailable` may use the pre-execution record, and only when no parent session was created. `wrong_model` requires model acceptance evidence, `non_fresh_session` requires an observed parent session, and `telemetry_collection_failure` requires a started attempt; they therefore use a session-started manifest with telemetry and deterministic evidence. A deterministic result may be `unavailable` with a reason when execution infrastructure prevented checks, but it is never omitted for a started attempt.

Ordinary implementation failures, missing candidate CLI files, timeouts after work begins, bad banners, test failures, voluntary early completion, and condition noncompliance remain intent-to-treat outcomes. They cannot be relabeled as pre-execution infrastructure. Noncompliance is derived from authenticated routing/tool/file evidence and omitted only from the per-protocol sensitivity set. An attempt is excluded if and only if `excluded=true` and one allowed non-null infrastructure/exclusion enum is recorded; included attempts require a null reason. Lifecycle `status` must agree with that exclusion state. Outcome-based reasons such as implementation failure, deterministic failure, or score are not in the enum and are rejected. An excluded observation is retried once at the next unused retry slot with a new session/workspace and the same prompt, repetition, condition, and coordinator. Attempt 1 uses run ID suffix `-A1`; its retry uses `-A2`. Both records remain and are joined only by schedule ID plus explicit reciprocal retry links.

Each of the 60 planned schedule IDs must have exactly one of three structures: (a) one included session-started A1 with no retry links; (b) one excluded A1 plus one included session-started A2, reciprocally linked; or (c) excluded A1 and A2 attempts, both using reasons allowed for their declared phase and reciprocally linked. Either or both excluded records in (b)/(c) may be honest pre-execution failures. Two pre-execution `session_creation_failure` records are valid and contain no fabricated session, telemetry, deterministic, artifact, condition, commit, or outcome evidence. Analysis selects the sole non-excluded attempt for (a) or (b). Structure (c) exhausts the retry and is a valid missing/excluded schedule rather than dataset corruption: it has no selected run and therefore requires no candidate artifact, blind bundle, or judgment. Any excluded started-attempt artifacts that were collectable may be retained but are never selected or judged. No further retries are allowed. Exclusions and compliance are decided from authenticated lifecycle/routing records before deterministic or judge outcomes are opened. Report intent-to-treat (all started valid assignments), the excluded-attempt flow and missing schedule IDs/reasons, and per-protocol sensitivity sets.

## Telemetry

Store source-faithful values plus availability metadata; never infer a missing field from another metric. Required raw fields are defined by `schemas/raw-telemetry.schema.json`:

- total session AI credits and raw nano-AIU-equivalent;
- per-model credits, nano-AIU-equivalent, input tokens, output tokens, and cached tokens where exposed;
- parent cumulative input tokens, parent peak input tokens, and parent output tokens;
- specialist cumulative/peak input, output tokens, and latency (treatment), with control aggregates marked `unavailable` with reason `control_condition_no_specialist`;
- exposed-tool count if available, tool call count, tool result count, per-tool names/statuses/durations;
- compaction event count and compact-return byte size, each with availability metadata in addition to source-faithful event records;
- wall latency, parent active latency, specialist latency, and parent wait latency under the authenticated policy below;
- routing evidence: requested model, observed model, session IDs, delegation call/result, timestamps, and raw event references authenticated against hashed raw-source bytes;
- manifest condition-evidence event-ID sets for delegation calls/results, specialist tool calls/results, and specialist file changes, reconciled exactly to telemetry.

Every metric is `{status,value,unit,source}` where status is `available`, `unavailable`, or `not_applicable`. Available counts, credits, tokens, latencies, and byte sizes are nonnegative. `unavailable` requires a null value and reason. Zero is a measured value, not a missing-data marker. Control specialist aggregates are unavailable specifically because the control has no specialist.

`parentWaitLatencyMs` is never available for control, including as zero, because control has no delegation wait; it must be `unavailable` with reason `control_condition_no_delegation_wait`. For treatment it is available only when the delegation call and result IDs bind to exact-byte-authenticated parent-session raw events and their timestamps equal `delegationEvidence.requestedAt` and `returnedAt`. Its formula is `Date.parse(returnedAt) - Date.parse(requestedAt)` in milliseconds using those same event boundaries as completed specialist latency, with an exact 0 ms tolerance. Partial, absent, unavailable, mismatched, or chronologically invalid boundaries require an unavailable parent-wait metric. Exposed-tool, tool-call/result, compaction, per-model usage, total-model, wall-latency, completed treatment delegation-latency, and parent-wait aggregates must reconcile exactly where their authenticated raw events or manifest timestamps define them; every normalized event and tool record is bound by event/call ID. Preserve raw export files unchanged and record exact-byte hashes.

## Deterministic checks

For session-started attempts, the external runner checks task behavior via the CLI process, isolated data files, exit status, JSON/text output, persistence, and negative cases. Pre-execution failures never run it and have no deterministic record. Each CLI process has a fixed 30-second timeout. On timeout the Windows-only runner terminates the entire job-object process tree and records a deterministic failed timeout assertion; a timeout after work begins is not an unavailable result. A missing candidate CLI is a deterministic implementation failure. For prompts requiring text results, text-output checks require the full normalized banner asset at stdout offset zero, exactly once, followed by nonempty prompt-specific expected result content; a banner alone or the required token alone fails. JSON-only invocations remain banner-free and are not subject to the text-result rule. `validate-art.js` checks the exact asset path, UTF-8/ASCII-only bytes, line endings, line count, width bounds, allowed character class, required literal token, forbidden trailing whitespace, and final newline. It also scans the workspace for unexpected extra `.txt` banner assets. Fixture-owned baseline tests must pass before materialization.

Deterministic result is pass only if every assertion in every functional, art, and tamper child group passes. A failed assertion makes its child group and the top-level result fail. An unavailable assertion makes its child group and, absent a failure elsewhere, the top-level result unavailable; every unavailable group and top-level result requires a reason. `unavailable` is missing data, never a failure or a pass, and binary analysis omits its pair without substituting zero. Record individual assertions; do not collapse missing execution into failure.

## Blinded judge design

After deterministic collection, authenticate each selected source artifact bundle by hashing its exact bytes and matching that hash to both the run manifest and artifact manifest. The source and blind schemas permit only the preregistered task prompt, sanitized deterministic result, and terminal diff/source/test/banner files; condition, model, session, branch, timing, token, routing, and arbitrary metadata fields or embedded metadata assignments/known values are rejected. Candidate serialized content and every forbidden exact condition/model/session/run/coordinator/specialist/workspace value are normalized with Unicode NFKC plus Node's locale-independent Unicode lowercase conversion before substring matching, so case variants cannot bypass blinding. Semantic provenance regular expressions remain case-insensitive. Before blind generation, deterministic messages/output and every candidate source, diff, fixture-test, and banner path/content are also scanned for conservative high-confidence provenance markers: generated/created by a delegated specialist or subagent, delegation to a specialist/subagent/nested session, control/treatment condition or arm labels, role-qualified or identified sessions, requested/observed/role-qualified models, model-routing phrases, and the registered delegation scope. Ordinary domain text such as “control flow,” “treatment plan,” “session cache,” or “data model” remains allowed so blind content stays useful for judging. A failed implementation may omit the banner, with that absence represented by deterministic art failure rather than fabricated content. `bind-blind-bundles.js` generates blind content from those authenticated bytes—it never selects a prebuilt bundle by blind filename or trusts a self-reported hash. Randomize filenames and bundle order using `design/judge-assignments.json`. Create one schema-valid runtime binding per blind ID whose schedule has a selected run, containing its assigned block, selected `runId`, exact-byte source artifact SHA-256, generated blind path, and exact-byte blind SHA-256. Dataset validation regenerates the expected blind content from authenticated source bytes and compares exact bytes and hashes. Judgments repeat the run and hash bindings and are rejected if any differ, so a replaced retry or artifact bundle cannot inherit a prior judgment.

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

Confidence intervals use a seeded nonparametric cluster bootstrap with prompts as clusters (`seed=845621`, 10,000 draws): sample exactly 10 prompt IDs with replacement and include all three within-prompt pairs for each sampled cluster. A confidence interval is unavailable unless all 60 planned schedule IDs have selected runs and all three pairs are available for every one of the 10 preregistered prompt clusters; any exhausted twice-excluded schedule globally withholds inferential output. Each outcome reports an explicit complete/incomplete status rather than silently reducing clusters or bootstrapping incomplete clusters. Point estimates still use complete pairs and explicitly report missing pairs by condition. `--allow-incomplete` permits an intentional empty-foundation dry-run or descriptive missing-schedule diagnostics, labels structural completeness explicitly, and never relaxes the complete-schedule/cluster rule. Also report prompt-level means, repetition-level results, intent-to-treat and per-protocol sensitivity, missingness by condition, excluded missing schedule IDs/reasons, and raw paired rows. No unpaired substitution, observation-level bootstrap, multiple-comparison significance claims, or post-hoc outcome switching.

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

## Pre-execution integrity amendment

Version `1.0.1` was registered before any model trial or outcome collection. It binds exact condition instructions and model provenance, enforces deterministic missingness, reciprocal retry linkage, and retry-selected blinded artifacts, requires six isolated judge sessions, bounds complete acceptance process trees, classifies candidate output errors as failures, compares rendered banners to their assets, requires exact integer-array P05 IDs, gates clustered intervals on all preregistered clusters, and exhaustively reports secondary telemetry availability. The art validator now rejects unexpected `.txt` files anywhere in the candidate workspace. These changes harden enforcement without changing the prompts, fixture, hypotheses, schedule, seeds, or planned sample.
