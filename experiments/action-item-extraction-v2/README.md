# Action-item extraction v2 feasibility

**Status: immutable development NO-GO; zero pilots started.** The one
development unit completed its exact view/edit mechanism, but the required
parent/worker `Tools:` schemas were not captured, so the documented parent
`edit` warning could not be accepted. Protocol ID:
`action-item-extraction-v2`. This directory is separate from immutable v1,
whose development-smoke NO-GO remains authoritative at merge
`4900bdde8250292c86d4040d242359359ac050a0` / PR #26.

V2 tests whether a project Skill can route GPT-5.6 Sol exactly once to a fixed
Claude Haiku 4.5 worker. The worker frontmatter remains exactly
`tools: ["read", "edit"]`; CLI 1.0.77 runtime evidence must show one structured
`view` and one builtin `edit` that replaces a precreated sentinel ledger.

## Frozen scope

- One fresh excluded development unit and three fresh excluded A4 pilots.
- Four synthetic transcripts and evaluator-only gold, each independently
  generated for v2 and hash-bound before execution.
- Fresh run IDs, deterministic UUIDv5 sessions, namespace, runtime, evidence,
  baseline, and evaluation paths.
- No A0-A3 AI, confirmatory, or main execution. Main IDs are reservations only;
  no main transcript or hash exists.
- A GO authorizes only a separate confirmatory preregistration pull request.

The candidate root for a run may contain only its two customization files, one
transcript, and the precreated `output\ledger.json` sentinel. The parent may not
view the transcript or view/edit the ledger. Gold is never materialized into a
candidate.

## Nonexperimental commands

From this directory:

```powershell
npm run validate
npm run baseline
npm run evaluate
npm test
npm run reproduce
```

`npm run freeze` is write-once and has already produced the checked-in freeze
manifests. `npm run fixtures` is likewise write-once and must not be rerun over
the concrete fixtures.

`npm run pilot -- --execute` was the only live command and has been consumed.
The preserved runtime and evidence roots prevent any retry. No live v2 command
is now authorized.

See [protocol-amendment-v2.md](protocol-amendment-v2.md), the frozen
[execution plan](design/execution-plan.json), and [report.md](report.md).
