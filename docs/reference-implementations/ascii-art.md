# Reference implementation: `ascii-art` (GitHub Copilot)

**Status: implemented; treatment frozen and experiment completed.** The live
[`SKILL.md`](../../.github/skills/ascii-art/SKILL.md) router and
[`ascii-art.agent.md`](../../.github/agents/ascii-art.agent.md) specialist provide the
concrete, checkable target for the [pattern description](../agent-skill-pattern.md).
A clean GitHub Copilot CLI smoke began without the target parent directory, had the
parent create it, delegated only the banner path and asset-local constraints, and kept
CLI/source integration in the parent. The trace used Claude Haiku 4.5 with only `read`
and `edit`; the agent edited only the banner, validated every supplied exact, minimum,
and maximum constraint, and returned terse status. The later measured experiment is
reported separately below.

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
`ascii-art` custom agent with the target path and every original asset-local constraint
rather than generating the banner inline. The parent first ensures that the target's
parent directory exists, because the specialist has no directory-creation tool. If
preparation or delegation fails, the router requires an explicit failure instead of
silent parent fallback. It explicitly forwards every supplied required-text, exact/
minimum/maximum line-count or width, allowed-character, whitespace, trailing-space,
final-newline, style, owned-path, and other asset-local constraint, while inventing
none. Consistent with
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
- **Prompt:** receives only the target path and original asset-local constraints:
  required text; exact, minimum, or maximum line-count and width limits when supplied;
  allowed characters; whitespace, trailing-space, and final-newline rules; style;
  owned-path restrictions; and any other supplied asset constraint. Only the target and
  a complete enumeration are required; individual constraints are required only when
  the original task supplied them. The agent invents no absent constraints, validates
  every supplied exact/minimum/maximum bound and other constraint, writes directly to
  the target, and returns terse path-plus-status rather than the art.

### Parent-owned preparation and integration

The parent creates or verifies the target's parent directory before delegation. It keeps
CLI/source integration requirements and post-delegation integration verification in its
own context; those requirements and paths are not sent to the specialist. Consequently,
every specialist read or edit target is the banner path itself. If directory preparation
fails, the parent reports the error without delegating or generating the art inline.
After the specialist returns, the parent alone performs and verifies integration.

## Direct write, terse return

Per the pattern's
[direct artifact write and compact return](../agent-skill-pattern.md#direct-artifact-write-and-compact-return)
mechanism, the subagent is expected to write the generated banner directly to its target
file using its edit tool, rather than returning the banner text through the parent's
context for the parent to write. The subagent's return to the parent is expected to be
limited to the artifact's path and a one-line success/failure status. The target's parent
directory already exists when the subagent starts.

## Validation

The clean routing smoke started from a workspace where the target parent directory was
absent. The parent created it before invocation and delegated only the banner path plus
the complete supplied asset-local constraint set. The trace selected
`claude-haiku-4.5`, exposed only `read` and `edit`, edited only the banner, and returned
the terse path/status contract. Read-back checks passed the supplied exact, minimum, and
maximum bounds, allowed-character, whitespace, trailing-space, and final-newline rules.
The parent handled CLI/source integration only after the subagent returned. This was a
routing smoke, not benchmark data or a measured benchmark result.

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
`6e2812c0e181502cb1aafbc5fa3e31761b4b54ed`; its frozen treatment is tag
`experiment-treatment-v1` at `ac0895c23c4c811cf10e5af5b42efcde12c14849`.
The [completed benchmark report](../../experiments/ascii-art-powershell-cli/report.md)
finds higher treatment credits and parent cumulative input, lower deterministic and
blinded quality, and lower wall latency among available complete pairs. Fourteen of
60 schedules are missing, primarily from model dispatch, so inference and
significance claims were withheld. See the
[repository README](../../README.md#benchmark) and
[observability and measurement](../agent-skill-pattern.md#observability-and-measurement)
for how measured results will be distinguished from inferred claims when the benchmark
is interpreted.
