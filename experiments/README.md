# Experiment index

This directory keeps the smallest useful research record for each experiment line:
one concise canonical protocol summary, one canonical report, reusable source where it
still serves a clear purpose, and one cross-study machine-readable summary. Frozen
protocol amendments remain only where retained machine contracts bind them. Original
immutable evidence remains available in Git history and the cited merge commits.

## Results at a glance

| Study | Parent goal / delegated subtask | Design | Combined AI credits (parent + worker) | Context and tokens | Wall time | Quality and reliability | Disposition |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [ASCII](ascii-art-powershell-cli/) | Implement a PowerShell CLI feature / create one ASCII banner | **Controlled**, paired; 60 planned, 46 selected, 20 complete ITT pairs | Control 16.40 + 0 = 16.40; treatment 25.40 + 2.43 = 27.83 (**+69.7%**) | Parent cumulative input **+53.9%**; complete-system model tokens **+59.3%** | Treatment **54.9% faster** | Deterministic pass **-25 pp**; blinded overall quality **-0.883/5** | No efficiency support; inference withheld because 14 schedules were missing |
| [Semantic corpus](semantic-test-corpus/) | Generate migration acceptance scenarios / worker writes confined source scenarios | **Controlled**, 12 complete randomized blocks; A5 target versus A1 GPT inline | A1 43.324 + 0 = 43.324; A5 9.251 + 17.256 = 26.507 (**-38.8%**) | Parent cumulative input **-58.0%**; total model tokens **+88.0%** | A5 **72.0% slower** | Path **-21.3 pp** vs A1 and **-11.7 pp** vs baseline; mutant kill **-43.9 pp** vs A1; adherence 1/12 | Credits saved, quality/reliability lost; preregistered combined signal not met |
| [Release notes](release-note-synthesis/) | Produce one customer-facing note / read one dossier and write one draft | **Excluded feasibility probes**; no valid control | v0 A4 mean 8.703 + 0.517 = **9.220**; no comparative estimate | Mean 31,041 total model tokens; direction not estimable; worker narration crossed the compact boundary | Mean **49.4 s** | 0/3 operational successes; v2 made 0 structured MCP calls; no draft to score | Runtime wiring failed before semantics; abandoned on CLI 1.0.77 |
| [Action items](action-item-extraction/) | Extract grounded commitments / read one transcript and write one ledger | **Excluded feasibility probes**; no valid control | v3 A4 mean 8.456 + 3.383 = **11.838**; no comparative estimate | Mean 39,488 model tokens; parent made zero transcript/ledger calls, but no control estimate exists | Mean **57.2 s** | Mean tuple F1 **0.462**; 100% source grounding failed; two unsupported critical actions | Mechanics isolated context; held-out quality failed; NO-GO |
| [Feature documentation](documentation-delegation/) | Implement an API/CLI/library feature / write one bounded guide | **Preregistered design only**; 24 paired main blocks plus 2 excluded pilot blocks | Not started | Not started | Not started | External feature, snippet, output, link, coverage, and claim checks frozen | Zero AI observations; execution not authorized |
| [Unit tests](unit-test-delegation/) | Implement a business-logic feature / write one bounded unit-test file | **Excluded pilot authorized, not started**; 30 paired main blocks plus 2 excluded pilot blocks | Not started | Not started | Not started | External feature, hidden acceptance, mutation, coverage, isolation, and duplicate/trivial checks frozen | Zero AI observations; guarded pilot requires explicit `--execute`; main forbidden |

Credits are the measured runtime AI-credit/nano-AIU proxy, not dollar cost. Combined
values include parent and worker usage, not evaluator or judge usage. Differences are
reported only where a valid comparator exists.

All semantic-quality claims come from deterministic evaluators outside model context;
ASCII additionally used blinded artifact judgments. Parent-model self-grading was not
used. The release-note and action-item lines are feasibility probes, not controls or
causal tests. No main study followed.

## Retention policy

| Classification | Policy |
| --- | --- |
| Executable source and customizations | Keep live Skills, agents, confined MCP services, tests, and the latest action-item candidate. |
| Reproducibility methodology | Keep one concise protocol summary per line plus frozen amendments, schedules, and fixtures only when retained contracts or tests still bind them. |
| Canonical results | Keep one concise report per line and [`results-summary.csv`](results-summary.csv). |
| Raw/intermediate evidence | Remove event streams, usage exports, runtime payloads, copied candidates, per-run bundles, and local database extracts. |
| Duplicated generated output | Remove dashboards, charts, duplicate reports, vendored judged sources, and derivable analysis packages. |
| Abandoned runtime scaffolding | Remove release-note/action one-shot launchers and evidence packagers that cannot be reused for planned unit-test/documentation work. |
| Obsolete temporary material | Remove superseded protocol amendments, pilot packaging, stale generators, and empty staging markers. |

Hashes are retained only where they bind a retained protocol, fixture, schedule, or
source. The original evidence and full evolution remain auditable through repository
history; pruning does not relabel failures or rewrite their dispositions.
