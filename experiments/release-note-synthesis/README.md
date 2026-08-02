# Release-note synthesis feasibility

This line asked whether a GPT-5.6 Sol parent could route one frozen public PR/issue
dossier to a fixed Claude Haiku 4.5 worker that read once, wrote one customer-facing
draft, and returned compact integrity metadata.

- [`protocol.md`](protocol.md) records the planned boundary and gate.
- [`report.md`](report.md) is the canonical result.
- The live reference Skill, agent, MCP implementation, and tests remain at
  [`.github/skills/release-note-synthesis/`](../../.github/skills/release-note-synthesis/),
  [`.github/agents/release-note-haiku.agent.md`](../../.github/agents/release-note-haiku.agent.md),
  [`tools/release-note-mcp/`](../../tools/release-note-mcp/), and
  [`tests/release-note-mcp/`](../../tests/release-note-mcp/).

The excluded probes never reached semantic evaluation. The v0 A4 pilot produced no
drafts and 0/3 operational successes. A one-shot v2 repair still made zero structured
MCP calls because CLI/runtime wiring and Windows sandbox startup failed. No valid
control, pilot confirmation, or main study exists.

One-shot launchers, copied dossiers/gold, runtime payloads, and evidence packagers were
removed because they are not reusable infrastructure. The failed outcomes remain in
the report and original PR #24/#25 history.
