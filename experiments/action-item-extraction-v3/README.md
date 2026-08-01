# Action-item extraction v3 preregistration

**Status: design frozen; no v3 AI unit has started.** Protocol ID:
`action-item-extraction-v3`. This namespace is separate from immutable v1 and v2
inputs, IDs, sessions, schedules, hashes, evidence, thresholds, and dispositions.

V2 remains immutable at PR #27 / merge
`9f3add6986105dd18ac1b4ed8f3cdf2edd639f5a`: its one excluded development unit
matched 12/12 tuples with precision, recall, and F1 of 1.00; handled rescission,
reassignment, and date changes; produced zero unsupported commitments; used one
worker view and one worker edit with no parent file calls; returned valid,
compact, isolated output; consumed 38,410 model tokens and 55.08 seconds. V2
remains NO-GO because its debug logs lacked the then-required distinct
parent/worker `Tools:` blocks. Its 1/12 source-grounding result remains unchanged.
No v2 pilot ran.

## Frozen v3 scope

- Exactly three fresh excluded-pilot transcripts and evaluator-only gold
  inventories, all under fresh v3 IDs.
- A4 only: GPT-5.6 Sol routes once to fixed Claude Haiku 4.5.
- CLI 1.0.77 with global
  `--available-tools=task,view,edit --allow-all-tools --disable-builtin-mcps`.
- Exactly one worker whole-transcript view and one worker sentinel-replacing
  edit; zero parent transcript or ledger calls and no other worker tools.
- Exact bracketed transcript-line citations required for every tuple.
- No A0-A3 AI observation, development observation, main observation, or v3
  lifecycle evidence exists in this design-only change.

## Deterministic design commands

From this directory:

```powershell
npm run validate
npm test
npm run check
npm run reproduce
```

`npm run fixtures` and `npm run freeze` are write-once and have already produced
the checked-in foundation. `npm run pilot -- --execute` is the only AI lifecycle
entry point. It is not authorized in this session and was not invoked.

See [protocol-amendment-v3.md](protocol-amendment-v3.md),
[design/execution-plan.json](design/execution-plan.json), and
[design/no-run-attestation.json](design/no-run-attestation.json).
