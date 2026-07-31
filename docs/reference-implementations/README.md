# Reference implementations

| Reference | What it demonstrates | Status |
| --- | --- | --- |
| [ASCII art](ascii-art.md) | Minimal Skill-to-agent routing for a small bounded asset task | Implemented; [case study complete](../../experiments/ascii-art-powershell-cli/) with descriptive results only |
| [Semantic test corpus](semantic-test-corpus.md) | AI-only semantic source-scenario proposals with deterministic migration/oracle ownership and confined staging | Implemented; [five-arm design preregistered](../../experiments/semantic-test-corpus/README.md), with no AI trials or AI results yet |

The semantic reference also includes the [research basis](../research/semantic-corpus-generation.md),
live [Skill](../../.github/skills/semantic-test-corpus/SKILL.md) and
[custom agent](../../.github/agents/semantic-test-corpus.agent.md), the
[trusted confined MCP launcher](../../tools/semantic-corpus-mcp/launcher.mjs) and
[tests](../../tests/semantic-corpus-mcp/), and the
[executable protocol](../../experiments/semantic-test-corpus/protocol.md#arms).
