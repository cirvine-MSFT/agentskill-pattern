# Reference implementations

- [Release-note synthesis](../../experiments/release-note-synthesis/) — one frozen
  public-source dossier read, one direct customer-facing draft write, and a compact
  integrity-only return. The included pilot is excluded from any later confirmation.

| Reference | What it demonstrates | Status |
| --- | --- | --- |
| [ASCII art](ascii-art.md) | Minimal Skill-to-agent routing for a small bounded asset task | Implemented; [case study complete](../../experiments/ascii-art-powershell-cli/) with descriptive results only |
| [Semantic test corpus](semantic-test-corpus.md) | AI-only semantic source-scenario proposals with deterministic migration/oracle ownership and confined staging | Implemented; [protocol-v5 case study complete](../../experiments/semantic-test-corpus/report.md) with 12 complete randomized blocks and descriptive ITT results |

The semantic reference also includes the [research basis](../research/semantic-corpus-generation.md),
live [Skill](../../.github/skills/semantic-test-corpus/SKILL.md) and
[custom agent](../../.github/agents/semantic-test-corpus.agent.md), the
[path-constrained MCP server](../../tools/semantic-corpus-mcp/server.mjs) and
[tests](../../tests/semantic-corpus-mcp/), and the
[completed protocol-v5 benchmark](../../experiments/semantic-test-corpus/report.md).
