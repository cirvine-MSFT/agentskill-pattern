# Agent Skill Pattern

**Agent Skill Pattern** is repository-local terminology for a specific composition of
already-established agent mechanisms: a small, progressively disclosed Agent **Skill**
that helps a parent model discover a bounded need, which in turn instructs or causes
the runtime to delegate to a separate, cost-tiered, tool-minimized **custom subagent**.
The subagent writes its output artifact directly to the workspace and returns a compact
status to the parent, instead of streaming the work through the parent's own context.

This is **not presented as a novel technique**. Progressive disclosure, cost-tiered
model selection, narrow tool allowlists, isolated subagent contexts, and compact returns
are independently documented across multiple platforms. Direct subagent artifact writes
are a more specific implementation tactic; LangChain Deep Agents is the closest
documented match found in the survey. What this repository names is the particular
*wiring* of these mechanisms and tactics, for use as shared vocabulary within this
repository and its reference implementations. See
[Research and prior art](#research-and-prior-art) below for the evidence behind that
claim.

## Pattern summary

| Role | Responsibility |
| --- | --- |
| **Harness** | Hosts the parent session, surfaces installed Skills and custom agents, and performs the actual delegation when the parent chooses to invoke a subagent. |
| **Parent** | Maintains session continuity and access to relevant repository state, subject to the model's finite context window (and potentially lossy compaction over a long session). Sees only Skill metadata until a Skill is triggered. |
| **Skill** | A minimal, progressively disclosed router. Its job is *discovery and routing only* — recognizing that a bounded task matches its description and instructing the parent to delegate to a named subagent. It does not do the work itself. |
| **Subagent** | A separate custom agent, usually on a cheaper/smaller model, with a narrow, task-specific tool allowlist and an isolated context window. It performs the bounded work, writes the resulting artifact directly, and returns a terse status. |

See [`docs/agent-skill-pattern.md`](docs/agent-skill-pattern.md) for the full breakdown
of roles, the discovery/progressive-disclosure flow, model selection, artifact-write
semantics, recursive-delegation protection, failure modes, and when *not* to use this
pattern.

## When and why to use it

Use this pattern when a parent session repeatedly recognizes a **narrow, well-bounded**
sub-task (for example, generating one asset in a fixed format) that:

- doesn't need the parent's full conversation history or repository context to complete, and
- can be done correctly by a smaller/cheaper model with a small, fixed set of tools.

The intended benefit is context and cost reduction, but the mechanism differs by role:
the **parent** benefits because the delegated work's reasoning, tool calls, and artifact
content stay isolated in the subagent and never enter the parent's (more expensive)
context — only a compact status returns. The **subagent** benefits separately because
its own narrow tool allowlist means fewer tool schemas, fewer competing choices, and
fewer irrelevant results for *it* to reason over — this does not reduce the parent's
tool schema footprint, since the parent's own toolset is unchanged. Reduced tool surface
on the subagent is also a secondary safety benefit, not the primary motivation for either
role. It is a poor fit for open-ended, conversational, or broad-tool-access work; see
[`docs/agent-skill-pattern.md`](docs/agent-skill-pattern.md#when-not-to-use-this-pattern).

## Architecture

Editable [Excalidraw](https://aka.ms/excalidraw) sources live in
[`docs/diagrams/`](docs/diagrams/) alongside their PNG exports.

[![Agent Skill discovery and invocation flow](docs/diagrams/discovery-and-invocation.png)](docs/diagrams/discovery-and-invocation.excalidraw)

*Discovery and invocation* — [editable source](docs/diagrams/discovery-and-invocation.excalidraw)

[![Parent and specialist context boundaries](docs/diagrams/context-and-cost-boundary.png)](docs/diagrams/context-and-cost-boundary.excalidraw)

*Context and cost boundary* — [editable source](docs/diagrams/context-and-cost-boundary.excalidraw)

See [`docs/diagrams/README.md`](docs/diagrams/README.md) for full alt text and
descriptions of both diagrams.

## Reference implementation

The live GitHub Copilot reference implementation consists of the
[`ascii-art` routing Skill](.github/skills/ascii-art/SKILL.md) and
[`ascii-art` custom agent](.github/agents/ascii-art.agent.md). The
[implementation notes](docs/reference-implementations/ascii-art.md) describe how the
minimal router delegates bounded asset work to Claude Haiku 4.5 with only `read` and
`edit`, direct artifact writes, and terse status returns.

## Benchmark

The benchmark foundation is available at
[`experiments/ascii-art-powershell-cli`](experiments/ascii-art-powershell-cli). Its
immutable control is tag `experiment-control-v1` at
`6e2812c0e181502cb1aafbc5fa3e31761b4b54ed`. The treatment has not yet been frozen, and
**no benchmark results exist yet**.

## Research and prior art

[`docs/research/prior-art.md`](docs/research/prior-art.md) is the source-of-truth
survey behind the claims above. In summary: no source surveyed documents this exact
composition as a single named pattern. **LangChain's Deep Agents `SubAgent` schema is
the closest documented structural match** — combining a model override, an explicitly
minimal tool allowlist, isolated per-subagent progressive-disclosure skills, and a
structured return on one object — but even Deep Agents does not document a Skill's own
activation as the mechanism that causes the parent to invoke the subagent, which is the
narrower distinction this repository's pattern draws. See the report's
[terminology recommendation](docs/research/prior-art.md#7-terminology-recommendation)
and [conclusion](docs/research/prior-art.md#8-conclusion) for the full reasoning, and
[`docs/research/evidence.csv`](docs/research/evidence.csv) /
[`docs/research/search-log.md`](docs/research/search-log.md) for supporting evidence and
search methodology.

## Status

This repository contains the pattern documentation, benchmark foundation, and live
GitHub Copilot reference implementation. An isolated CLI routing smoke has passed, but
the benchmark treatment is not yet frozen and no measured benchmark results exist.

## License

Released under the [MIT License](LICENSE).
