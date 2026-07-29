# The Agent Skill Pattern

This document is the detailed reference for the **Agent Skill Pattern** introduced in
the [repository README](../README.md). It assumes you've read the summary there.

> **Terminology note.** "Agent Skill Pattern" is this repository's name for a specific
> composition of established mechanisms — it is not a claim of a new primitive. See
> [`docs/research/prior-art.md`](research/prior-art.md) for the evidence behind every
> claim in this document, and particularly its
> [terminology recommendation](research/prior-art.md#7-terminology-recommendation) and
> [conclusion](research/prior-art.md#8-conclusion).

## Roles

The pattern has four participants:

### Harness

The agent runtime (for example, GitHub Copilot) that hosts a session. The harness is
responsible for:

- surfacing installed Agent Skills' `name`/`description` metadata to the parent model at
  startup (the first level of progressive disclosure), and
- performing the actual delegation — starting an isolated subagent process/context —
  when the parent model chooses to invoke a custom agent as a subagent.

The harness does not itself decide *when* to delegate; that decision is the parent
model's, informed by the Skill.

### Parent

The primary model in the session (in the reference implementation, GPT-5.6 Sol). The
parent:

- retains the full user request, conversation history, and repository context for the
  life of the session,
- sees only Skill metadata (name + description) until a Skill is triggered by relevance,
  and
- upon recognizing a bounded task that matches a Skill's description, is instructed by
  that Skill's body to delegate to a specific named subagent rather than doing the work
  itself.

### Skill

A minimal `SKILL.md` file whose **only job in this pattern is discovery and routing**.
Its frontmatter `name`/`description` is what the parent sees at startup (Level 1 of
progressive disclosure); its Markdown body — loaded only once the Skill is triggered
(Level 2) — instructs the parent to delegate to a named subagent rather than
carrying out the task's instructions itself. This is a deliberately narrow usage of the
Agent Skills mechanism: as documented in
[prior-art.md §4](research/prior-art.md#4-overlap-and-differences-vs-the-proposed-composition),
every vendor's Skills feature is designed to carry task instructions for the *same*
agent that discovers it — using a Skill purely as a routing trigger into a *different*
agent is a usage choice this repository makes, not a separately documented sub-feature
of the Agent Skills specification.

### Subagent

A separate custom agent (in the reference implementation, a Claude Haiku 4.5-backed
custom agent) that:

- runs in its own isolated context window, with no automatic access to the parent's
  conversation history,
- is restricted to a small, task-specific tool allowlist,
- performs the bounded work,
- writes its output artifact **directly** to the workspace rather than returning large
  content through the parent, and
- returns a **compact status** to the parent (for example, a file path and a one-line
  success/failure summary).

## Discovery and progressive disclosure flow

The pattern relies on the same three-level progressive-disclosure model documented for
Agent Skills generally (see
[prior-art.md §3.1](research/prior-art.md#31-anthropic--claude--agent-skills-and-subagents-documented-as-separate-mechanisms)):

1. **Metadata (`name` + `description`)** — loaded into the parent's context at session
   startup for every installed Skill. This is the only per-Skill cost the parent pays
   before a Skill is relevant.
2. **Body** — loaded only when the parent judges the Skill's description matches the
   current task. In this pattern, the body's entire content is routing instructions:
   recognize the bounded task, then delegate to the named subagent.
3. **Bundled resources** — loaded on demand thereafter, if the Skill references
   additional files. The reference implementation does not require this level.

See [`docs/diagrams/discovery-and-invocation.png`](diagrams/discovery-and-invocation.png)
for the visual flow, and
[`docs/diagrams/README.md`](diagrams/README.md) for its full alt text.

## Separate parent isolation vs. specialist minimization

The pattern deliberately treats the parent's and the subagent's context budgets as
**two different problems with two different solutions**:

- **Parent isolation** is about what the parent *doesn't have to hold*: instead of the
  subagent streaming its intermediate tool calls, drafts, and reasoning back through the
  parent's context, the subagent writes its artifact directly and returns only a compact
  status. The parent's context grows by a few lines, not by the full working set of the
  sub-task.
- **Specialist minimization** is about what the subagent *doesn't have available in the
  first place*: a narrow, task-specific tool allowlist (in the reference
  implementation, read/edit tools only) rather than the parent's full toolset.

These are complementary but distinct levers. Isolation limits what comes *back*;
minimization limits what tools exist to be chosen from *inside* the subagent. See
[`docs/diagrams/context-and-cost-boundary.png`](diagrams/context-and-cost-boundary.png)
for a side-by-side view of both boundaries.

## Model selection

The parent and subagent are expected to run on **different cost tiers**, chosen for the
shape of the work each does:

- The **parent** runs on a higher-reasoning, higher-cost model (GPT-5.6 Sol in the
  reference implementation) because it must reason over the full request, repository
  state, and orchestration decisions.
- The **subagent** runs on a smaller, cheaper model (Claude Haiku 4.5 in the reference
  implementation) because its task is narrow and bounded, and a smaller model is
  expected to be sufficient.

GitHub Copilot's own billing documentation is the **measured** evidence for this cost
differential — see
[prior-art.md §3.3](research/prior-art.md#33-github-copilot--custom-agents-agent-skills-and-sub-agent-orchestration-the-reference-platform)
for the cited, dated pricing figures. Whether the smaller model produces
acceptably-equivalent output quality for a given task is a claim this repository does
**not** make without a benchmark; see [Observability and measurement](#observability-and-measurement).

## Direct artifact write and compact return

Rather than generating content and returning it through the parent's context (where it
would consume parent tokens and require the parent to relay or re-write it), the
subagent:

1. writes its output artifact directly to the workspace using its own read/edit tools, and
2. returns a compact status to the parent — for example, a file path and a one-line
   result summary, not the artifact's content.

This mirrors the closest documented prior art found for this specific mechanism:
LangChain Deep Agents' virtual-filesystem tools (`write_file`/`edit_file`), available to
subagents and independently restrictable per subagent — see
[prior-art.md §3.2](research/prior-art.md#32-langchain-deep-agents--the-closest-documented-structural-match).
As that section notes, no source — including this one — frames direct artifact writes
as an explicitly named "artifact bypass" technique; it is a general filesystem-tool
capability that this pattern applies deliberately to reduce the parent's token
consumption.

## Recursive delegation protection

A subagent must not be able to trigger further, unbounded delegation (a subagent
invoking another subagent, and so on). This pattern protects against that recursion
**structurally, not just by instruction**:

- **Structural:** the subagent's tool allowlist omits the tool the harness uses to
  invoke further custom agents (for example, an `agent`/delegation tool). If the
  capability to delegate isn't in the subagent's tool schema at all, it cannot be
  invoked, regardless of what the subagent's prompt says.
- **Prose guard, as a second layer:** the subagent's system prompt additionally states
  that it must complete its bounded task directly and must not attempt to delegate
  further. This is a defense-in-depth measure, not the primary control — prompt text
  alone is not treated as sufficient protection.

See [`docs/reference-implementations/ascii-art.md`](reference-implementations/ascii-art.md#recursive-delegation-protection)
for how this is applied concretely.

## Failure modes

- **Skill misfires or fails to trigger.** The parent may miss a bounded task the Skill
  was meant to catch (under-triggering), or the parent may route a task to the subagent
  that actually needed the parent's full context (over-triggering). Both are routing
  errors in the Skill's `description` or the parent's own judgment, not failures of the
  subagent itself.
- **Subagent's tool allowlist is insufficient.** If the bounded task turns out to need a
  tool the subagent doesn't have, the subagent cannot complete it and must return a
  failure status rather than silently degrade or attempt an unavailable action.
- **Artifact write failure.** If the subagent's direct write fails (path conflict,
  permissions, etc.), the compact return must communicate failure clearly enough for the
  parent to retry or escalate — a bare "done" status that isn't actually true is the
  worst-case failure mode of this pattern, since the parent has no visibility into the
  subagent's intermediate steps to detect it otherwise.
- **Model-quality mismatch.** The cheaper subagent model may not produce
  acceptably-equivalent output for a given task. This is an empirical question this
  repository does not yet have benchmark evidence for (see below).
- **Recursive delegation, if the structural control is misconfigured.** If a subagent's
  tool allowlist is ever changed to include the delegation tool, the prose guard becomes
  the only remaining control, which this pattern explicitly does not treat as sufficient
  on its own.

## When not to use this pattern

- The task is **not bounded** — it needs open-ended, multi-turn conversation, or
  ongoing access to context the parent already holds (repository history, prior turns,
  user clarifications).
- The task **needs a broad or unpredictable tool set**, such that a fixed, narrow
  allowlist would need to be re-authored per task rather than reused.
- The task is a **one-off**, where the fixed cost of authoring and maintaining a
  `SKILL.md` and a custom agent definition exceeds the savings from delegating it.
- **Quality is uncertain and unverified** — until a benchmark exists for a given task
  shape, delegating to a cheaper model is a hypothesis, not a validated optimization.

## Observability and measurement

To evaluate whether this pattern is delivering its intended benefit for a given task,
observability should distinguish:

- **Measured evidence:** the per-token price differential between the parent and
  subagent models (measured, from GitHub Copilot's own billing documentation — see
  [prior-art.md §6](research/prior-art.md#6-measured-vs-inferred-schema-token-cost-claims)),
  and, once available, the results of the planned benchmark at
  `experiments/ascii-art-powershell-cli` (not yet merged; see the
  [repository README](../README.md#benchmark)).
- **Inferred, not yet measured:** the claim that a narrower tool allowlist reduces the
  subagent's context/token footprint is supported directionally by first-party
  qualitative guidance (Anthropic's context-engineering post, LangChain's Deep Agents
  docs), but **no precise, first-party measurement of tool-schema-specific token
  savings** was found in the prior-art research — see
  [prior-art.md §5](research/prior-art.md#5-context-minimization-vs-least-privilegesafety--a-deliberate-distinction)
  and [§6](research/prior-art.md#6-measured-vs-inferred-schema-token-cost-claims) for the
  full measured-vs-inferred breakdown.

Any dashboard, log, or report built on top of this pattern should keep these two
categories separate rather than implying that inferred savings are measured results.

## Security as a secondary benefit

The subagent's narrow tool allowlist has **context minimization as its primary
purpose in this pattern, not access control**:

- Fewer tool definitions loaded into the subagent's prompt means fewer tokens spent on
  tool schemas, fewer decision points for the model to reason over among competing
  tools, and typically more compact, on-topic tool outputs — a **context-engineering**
  concern, not a safety one. This mirrors Anthropic's own context-engineering framing
  (bloated tool sets create "ambiguous decision points" and deplete a finite "attention
  budget") and LangChain Deep Agents' explicit "keep this minimal" framing of a
  subagent's `tools` field — see
  [prior-art.md §5](research/prior-art.md#5-context-minimization-vs-least-privilegesafety--a-deliberate-distinction)
  for the exact citations.
- **Least privilege/safety is real, but secondary here.** Restricting the subagent to
  read/edit tools and omitting shell, web, search, and delegation tools also happens to
  reduce what the subagent could do if it misbehaved or were prompt-injected. This
  repository does not dispute that benefit, but it deliberately does not conflate it
  with the context-minimization rationale above — the prior-art research specifically
  flags gray-literature sources that blur the two together as an example of a conflation
  this repository avoids.

In short: the tool allowlist is designed the way it is because a smaller, focused tool
set makes the subagent's own reasoning cheaper and more reliable. That it also narrows
the blast radius of a misbehaving subagent is a welcome, secondary effect — not the
reason the allowlist is narrow.
