# Reference implementation: `ascii-art` (GitHub Copilot)

**Status: implemented; benchmark treatment not yet frozen.** The live
[`SKILL.md`](../../.github/skills/ascii-art/SKILL.md) router and
[`ascii-art.agent.md`](../../.github/agents/ascii-art.agent.md) specialist provide the
concrete, checkable target for the [pattern description](../agent-skill-pattern.md).
An isolated GitHub Copilot CLI smoke loaded the Skill, delegated to the custom agent,
wrote only the owned target, passed path/dimension/character/whitespace checks, and
returned terse status. This is not a measured benchmark result.

This is the reference implementation for the
[Agent Skill Pattern](../agent-skill-pattern.md), targeting GitHub Copilot as the
harness.

## Task

Generate an ASCII-art banner asset for a repository (for example, a `banner.txt` used
in a CLI's startup output) — a small, bounded, well-specified task that doesn't require
the parent's full conversation or repository context to complete correctly.

## Roles and configuration

| Role | Configuration |
| --- | --- |
| **Harness** | GitHub Copilot (CLI/session runtime) |
| **Parent model** | GPT-5.6 Sol |
| **Skill (router)** | [`.github/skills/ascii-art/SKILL.md`](../../.github/skills/ascii-art/SKILL.md) |
| **Subagent (custom agent)** | [`.github/agents/ascii-art.agent.md`](../../.github/agents/ascii-art.agent.md), backed by `claude-haiku-4.5` (Claude Haiku 4.5) |
| **Subagent tools** | `read` and `edit` aliases only |
| **Subagent tools explicitly excluded** | `agent` (delegation), search, shell/bash, web fetch/search |

### Skill as router

[`.github/skills/ascii-art/SKILL.md`](../../.github/skills/ascii-art/SKILL.md) carries
the minimal frontmatter the
[Agent Skills format](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)
defines — a `name` and a `description` precise enough for the parent to recognize
"generate/update an ASCII-art banner asset" as the trigger condition — with a body whose
entire content is a routing instruction: recognize the bounded request, then invoke the
`ascii-art` custom agent with all required constraints rather than generating the banner
inline. If that agent is unavailable, the router requires an explicit delegation failure
instead of silent parent fallback. Consistent with
[the pattern's discovery/routing role](../agent-skill-pattern.md#skill), the Skill body
does not itself contain ASCII-art generation instructions or examples; that knowledge
belongs to the subagent, not the router.

### Subagent as specialist

[`.github/agents/ascii-art.agent.md`](../../.github/agents/ascii-art.agent.md) defines a
[repository-level custom agent](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/invoke-custom-agents)
scoped as follows:

- **Model:** `claude-haiku-4.5` (Claude Haiku 4.5) — a cheaper, smaller model than the GPT-5.6 Sol parent,
  appropriate for a narrow, well-specified generation task. See
  [`docs/agent-skill-pattern.md`](../agent-skill-pattern.md#model-selection) for the
  measured cost differential this choice is based on.
- **Tools:** exactly the `read` and `edit` aliases. No `agent` (delegation), search,
  shell/execute, or web tools are exposed to this subagent. This primarily minimizes
  tool-schema context, competing tool choices, and irrelevant tool results within the
  isolated subagent; least privilege is a secondary benefit.
- **Invocation:** `target: github-copilot` and `user-invocable: false` keep the agent
  programmatic rather than manually selectable.
- **Prompt:** instructs the agent to generate the requested ASCII-art banner and write
  it directly to the target file path using its edit tool, then return a terse status
  (file path plus a one-line confirmation) — not the banner content itself — back to the
  parent.

## Direct write, terse return

Per the pattern's
[direct artifact write and compact return](../agent-skill-pattern.md#direct-artifact-write-and-compact-return)
mechanism, the subagent is expected to write the generated banner directly to its target
file using its edit tool, rather than returning the banner text through the parent's
context for the parent to write. The subagent's return to the parent is expected to be
limited to the artifact's path and a one-line success/failure status.

## Recursive delegation protection

This reference implementation applies both layers of protection described in
[`docs/agent-skill-pattern.md`](../agent-skill-pattern.md#recursive-delegation-protection):

1. **Structural:** the `ascii-art` custom agent's tool allowlist omits the `agent` tool
   entirely. Without that tool present in its schema, the subagent has no mechanism to
   invoke any further custom agent, regardless of what its prompt says.
2. **Prose guard:** the subagent's prompt additionally states that it must generate and
   write the banner directly and must not attempt to delegate the task further. This is
   a defense-in-depth layer on top of, not a substitute for, the structural restriction
   in (1).

## Benchmark

A benchmark foundation for comparing this reference implementation against parent-only
banner generation is available at
[`experiments/ascii-art-powershell-cli`](../../experiments/ascii-art-powershell-cli).
Its immutable control is tag `experiment-control-v1` at
`6e2812c0e181502cb1aafbc5fa3e31761b4b54ed`; the treatment has not yet been frozen.
**No benchmark results exist yet.** See the
[repository README](../../README.md#benchmark) and
[observability and measurement](../agent-skill-pattern.md#observability-and-measurement)
for how measured results will be distinguished from inferred claims when the benchmark
executes.
