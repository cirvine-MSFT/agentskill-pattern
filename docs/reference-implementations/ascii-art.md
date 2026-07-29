# Reference implementation: `ascii-art` (GitHub Copilot)

**Status: planned / contractual design.** No part of this reference implementation has
merged yet. `.github/skills/ascii-art/SKILL.md` and `.github/agents/ascii-art.agent.md`
do not exist in this repository as of this writing. This document describes the
contract those files are expected to satisfy once implemented, so that the
[pattern description](../agent-skill-pattern.md) has a concrete, checkable target. Do
not treat any path below as merged until it is actually present in the repository tree.

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
| **Skill (router)** | `.github/skills/ascii-art/SKILL.md` |
| **Subagent (custom agent)** | `.github/agents/ascii-art.agent.md`, backed by Claude Haiku 4.5 |
| **Subagent tools** | Read and edit tools only |
| **Subagent tools explicitly excluded** | `agent` (delegation), search, shell/bash, web fetch/search |

### Skill as router

`.github/skills/ascii-art/SKILL.md` is expected to carry the minimal frontmatter the
[Agent Skills format](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)
defines — a `name` and a `description` precise enough for the parent to recognize
"generate/update an ASCII-art banner asset" as the trigger condition — with a body whose
entire content is a routing instruction: recognize the bounded request, then delegate to
the `ascii-art` custom agent rather than generating the banner inline. Consistent with
[the pattern's discovery/routing role](../agent-skill-pattern.md#skill), the Skill body
does not itself contain ASCII-art generation instructions or examples; that knowledge
belongs to the subagent, not the router.

### Subagent as specialist

`.github/agents/ascii-art.agent.md` is expected to define a
[repository-level custom agent](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/invoke-custom-agents)
scoped as follows:

- **Model:** Claude Haiku 4.5 — a cheaper, smaller model than the GPT-5.6 Sol parent,
  appropriate for a narrow, well-specified generation task. See
  [`docs/agent-skill-pattern.md`](../agent-skill-pattern.md#model-selection) for the
  measured cost differential this choice is based on.
- **Tools:** read and edit tools only. No `agent` (delegation), search, shell/bash, or
  web fetch/search tools are exposed to this subagent.
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

A benchmark comparing this reference implementation against parent-only banner
generation is planned at `experiments/ascii-art-powershell-cli`, expected to merge as a
separate pull request. **No benchmark results exist yet.** See the
[repository README](../../README.md#benchmark) and
[observability and measurement](../agent-skill-pattern.md#observability-and-measurement)
for how measured results will be distinguished from inferred claims once that experiment
merges.
