# Search log — prior-art research for the Agent Skill + cheap-model subagent composition

**Date searched:** 2026-07-28
**Researcher:** GitHub Copilot CLI session (autopilot), on behalf of `cirvine-MSFT/agentskill-pattern`
**Scope of this log:** every fixed query and direct source fetch used to compile `prior-art.md` and `evidence.csv`, plus explicit negative/absence findings. This log intentionally records searches that found *nothing new or nothing on-point*, not only successful ones.

## 1. Composition under investigation

A minimal Agent Skill used purely for progressive-disclosure discovery/routing by a parent LLM, which — when triggered — invokes a custom subagent running on a cheaper/smaller model, with a narrow tool allowlist, an isolated context window, direct artifact writes, and a compact return value to the parent. Reference target: GitHub Copilot CLI with a GPT-5.6 Sol parent and a Claude Haiku 4.5 specialist subagent.

## 2. Source catalogs searched

| Catalog / surface | How searched |
| --- | --- |
| Anthropic (`anthropic.com/engineering`, `claude.com/blog`, `code.claude.com/docs`, `platform.claude.com/docs`) | Direct fetch of engineering blog posts and product docs; web search to locate exact URLs |
| Agent Skills open specification (`agentskills.io`) | Direct fetch of specification page |
| GitHub / GitHub Copilot (`docs.github.com`, `github.blog/changelog`) | Direct fetch of CLI/SDK custom-agent docs, Agent Skills concept and how-to docs, supported-models reference, billing/pricing reference, and the GPT-5.6 changelog post |
| OpenAI Agents SDK (`openai.github.io/openai-agents-python`) | Direct fetch of Agents, Handoffs, and Agent-orchestration pages |
| Google Agent Development Kit (`adk.dev`, formerly `google.github.io/adk-docs`) | Direct fetch of workflows/multi-agent, collaboration, and Skills pages (redirects followed); fetched the `google/adk-docs` GitHub commit history for `docs/skills/index.md` via the GitHub REST API to verify the page's original publication date |
| Microsoft AutoGen (`microsoft.github.io/autogen`) | Direct fetch of the Handoffs design-pattern page |
| Microsoft Semantic Kernel (`learn.microsoft.com/semantic-kernel`) | Direct fetch of Handoff Agent Orchestration page |
| Microsoft Azure Architecture Center (`learn.microsoft.com/azure/architecture`) | Direct fetch of the AI Agent Orchestration Patterns guide |
| LangChain / LangGraph (`docs.langchain.com`, `langchain-ai.github.io`) | Direct fetch of Multi-agent, Subagents, and (attempted, redirected) LangGraph multi-agent concept pages; web search to resolve moved URLs |
| CrewAI (`docs.crewai.com`) | Direct fetch of the Agents, Skills, and Agent Capabilities concepts pages (redirects followed to versioned `v1.15.8` URLs); fetched the `crewAIInc/crewAI` GitHub PR history and the `1.15.8` release metadata via the GitHub REST/search API to verify the Skills doc's rewrite date and the docs version's release date |
| arXiv | Direct fetch of abstract/HTML pages for FrugalGPT (2305.05176), RouteLLM (2406.18665), AutoGen (2308.08155), and a lazy-tool-loading preprint (2604.21816) |
| Independent research (Chroma) | Direct fetch of the "Context Rot" research report |
| Gray literature / community (blogs, Reddit-quoting blogs) | General web search only; individually fetched two representative posts (`youcanbuildthings.com`, `eesel.ai`) to verify quotes rather than trusting search-summary prose |

General web search (Bing-backed AI search tool) was used only to *discover* candidate URLs or to triangulate terminology; every substantive claim used in `prior-art.md` / `evidence.csv` was re-verified by fetching the primary page or paper directly, per the task's verification requirement. Two exceptions are explicitly flagged low-confidence in `evidence.csv`: the arXiv 2604.21816 preprint (title/abstract page only, not independently re-derived in depth) and the `eesel.ai` gray-literature summary (used only to illustrate a conflation of rationales, not as a factual authority).

## 3. Fixed queries run (web search)

1. `Anthropic Agent Skills specification SKILL.md progressive disclosure documentation`
2. `GitHub Copilot CLI custom subagents "agent_type" tool allowlist documentation`
3. `Claude Code subagents feature documentation isolated context separate context window`
4. `FrugalGPT model cascade paper arxiv reduce LLM cost`
5. `RouteLLM learning to route LLM queries arxiv paper`
6. `GitHub Copilot CLI docs create custom subagents .github/agents markdown frontmatter`
7. `GitHub Copilot models GPT-5.6 Sol Claude Haiku 4.5 available models list`
8. `docs.langchain.com langgraph multi-agent overview page`
9. `AutoGen enabling next-gen LLM applications multi-agent conversation arxiv abstract`
10. `LangGraph multi-agent supervisor subgraph documentation site:langchain-ai.github.io`
11. `"context engineering" multi-agent subagent "context window" Anthropic blog subagents section quote`
12. `"skill" triggers "subagent" cheaper model blog "progressive disclosure" routing pattern name`
13. `reddit OR blog "skills" "subagents" pattern name "cheap model" cost savings Claude Code informal terminology`
14. `tool schema token overhead many tools context length degradation paper measurement`
15. `Google ADK Agent Development Kit official Skills documentation SKILL.md metadata-first discovery site:adk.dev OR site:google.github.io`
16. `"adk.dev" Agent Skills "progressive disclosure" SKILL.md documentation`
17. `CrewAI v1.15.8 release changelog date skills feature`

## 4. Direct primary-source fetches (verification pass)

- `https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills`
- `https://agentskills.io/specification`
- `https://code.claude.com/docs/en/sub-agents`
- `https://claude.com/blog/subagents-in-claude-code`
- `https://claude.com/blog/skills-explained`
- `https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents`
- `https://www.trychroma.com/research/context-rot`
- `https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/custom-agents`
- `https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/invoke-custom-agents`
- `https://docs.github.com/en/copilot/concepts/agents/about-agent-skills`
- `https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills`
- `https://docs.github.com/en/copilot/reference/ai-models/supported-models`
- `https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing`
- `https://github.blog/changelog/2026-07-09-openais-gpt-5-6-sol-terra-and-luna-are-now-available-in-github-copilot/`
- `https://openai.github.io/openai-agents-python/handoffs/`
- `https://openai.github.io/openai-agents-python/agents/`
- `https://openai.github.io/openai-agents-python/multi_agent/`
- `https://adk.dev/workflows/` and `https://adk.dev/workflows/collaboration/`
- `https://adk.dev/skills/` (Google ADK Skills — redirects from `https://google.github.io/adk-docs/skills/`)
- `https://developers.googleblog.com/developers-guide-to-building-adk-agents-with-skills/` (Google developer blog walkthrough that links to and quotes the `adk.dev/skills/` reference; used only to locate the primary doc URL, not cited as the source of quotes)
- `https://api.github.com/repos/google/adk-docs/commits?path=docs/skills/index.md` (GitHub REST API — commit history for the ADK Skills doc file, used to verify its original 2026-02-13 publication date and most recent 2026-07-24 revision)
- `https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/design-patterns/handoffs.html`
- `https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/handoff`
- `https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns`
- `https://docs.langchain.com/oss/python/langchain/multi-agent`
- `https://docs.langchain.com/oss/python/langchain/multi-agent/subagents`
- `https://docs.crewai.com/v1.15.8/en/concepts/agents.md`
- `https://docs.crewai.com/v1.15.8/en/concepts/skills.md` (CrewAI Skills — SKILL.md format, progressive-disclosure discovery/activation)
- `https://docs.crewai.com/v1.15.8/en/concepts/agent-capabilities.md` (CrewAI Agent Capabilities overview — combined `tools`/`mcps`/`apps`/`skills`/`knowledge_sources` example, used to confirm `skills` and `tools` are documented as independently combinable Agent attributes)
- `https://api.github.com/repos/crewAIInc/crewAI/releases/tags/1.15.8` (GitHub REST API — confirms `1.15.8` was published 2026-07-28T15:06:04Z)
- `https://api.github.com/search/issues?q=repo:crewAIInc/crewAI+%22concepts/skills.mdx%22+in:title,body+type:pr&sort=created&order=asc` (GitHub search API — located PR crewAIInc/crewAI#5189, merged 2026-03-31, which substantially rewrote the Skills concept doc to its current progressive-disclosure/Skills-vs-Tools framing)
- `https://arxiv.org/abs/2305.05176` (FrugalGPT)
- `https://arxiv.org/abs/2406.18665` (RouteLLM)
- `https://arxiv.org/abs/2308.08155` (AutoGen abstract — fetched directly via the arXiv abstract page, same method as FrugalGPT and RouteLLM)
- `https://arxiv.org/abs/2604.21816` (title/abstract page only — Tool Attention / lazy schema loading)
- `https://youcanbuildthings.com/articles/claude-code-subagents-token-usage/`
- `https://www.eesel.ai/blog/subagents-in-claude-code`

Attempted but redirected/unavailable and re-fetched at the resolved URL: `google.github.io/adk-docs/agents/multi-agents/` → `adk.dev/workflows/`; `docs.crewai.com/concepts/agents` → versioned `.md` URL; `langchain-ai.github.io/langgraph/concepts/multi_agent/` (redirect loop, abandoned in favor of `docs.langchain.com/oss/python/langchain/multi-agent`, which covers the same content under LangChain's current docs structure).

## 5. Explicit negative / absence results

These are deliberately recorded because the task requires distinguishing "not found" from "not searched":

1. **No canonical or standard name found** for the specific composition under investigation (Skill-as-discovery-layer → triggers a narrow-tool, cheap-model, isolated-context subagent → returns a compact result to the parent) in any vendor documentation, open specification, pattern catalog, or academic source examined. Of the sources reviewed, **Anthropic**, **LangChain**, **GitHub Copilot**, **Google ADK**, and **CrewAI** document *both* a Skill-equivalent progressive-disclosure mechanism *and* a subagent/delegation mechanism — and all five treat "skills" (or an equivalent knowledge-loading mechanism) and "subagents/handoffs/delegation" as **two separate, independently named mechanisms**, not one composed pattern. This is clearest in `docs.langchain.com/oss/python/langchain/multi-agent`, which explicitly lists "Subagents" and "Skills" as sibling rows in its own pattern-comparison table; for GitHub Copilot it is clearest in the fact that "Custom agents" and "Agent Skills" are documented on separate concept/how-to pages (`docs.github.com/en/copilot/concepts/agents/about-agent-skills` vs. `docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/invoke-custom-agents`); for Google ADK it is clearest in the fact that its Skills page (`adk.dev/skills/`) and its coordinator/subagent collaboration-modes page (`adk.dev/workflows/collaboration/`) are two entirely separate doc pages with no cross-reference wiring one to the other; for CrewAI it is clearest in the fact that its Skills concept page (`docs.crewai.com/v1.15.8/en/concepts/skills.md`) and its `allow_delegation` agent attribute (`docs.crewai.com/v1.15.8/en/concepts/agents.md`) are documented separately, with no page found that names a single composed pattern spanning both. No page found across any of these five vendors names a single composed pattern spanning both. **This naming gap is narrower than an absence of capability:** GitHub Copilot's own `customAgents` SDK configuration reference (`docs.github.com/en/copilot/how-tos/copilot-sdk/features/custom-agents`) explicitly documents a per-agent `model` field ("override the parent session's model settings while a custom agent runs") and a per-agent `skills` field (eagerly preloading a named skill's full content into that agent's context at startup, opt-in, not inherited from the parent) on the same agent object as the `tools` allowlist — see `evidence.csv` row 29. Claude Code's own subagent docs (`code.claude.com/docs/en/sub-agents`) independently document the same combination on a single subagent's YAML frontmatter: a `tools` field, a `model` field, and a `skills` field described as preloading "the full skill content... not only the description" — see `evidence.csv` row 3. CrewAI's own `Agent` object independently documents the same shape: an `llm` field (per-agent model choice), a `tools` field, and a `skills` field, which its docs show combined in one `Agent()` call — see `evidence.csv` row 33. GitHub Copilot, Claude Code, and CrewAI are equivalent prior art on this point; none is uniquely positioned. In all three, the `skills` field/argument is a static, developer-configured preload (CrewAI's own docs state that in the common `Agent(skills=[...])` usage, listed skills are "automatically discovered and activated" together, not triggered one at a time), not the relevance-triggered, progressive-disclosure mechanism that defines Agent Skills elsewhere in each vendor's own docs, so it does not itself constitute the composed pattern in scope; but the underlying capability to combine a cheaper model, a tool allowlist, and skill content on one subagent/agent definition is directly documented in all three vendors' docs, not absent. Google ADK independently documents a Skill-equivalent progressive-disclosure layer (`SkillToolset`, L1 metadata → L2 instructions "loaded when the Skill is triggered by the agent" → L3 resources; see `evidence.csv` row 32) — a very close match, at the schema level, for Anthropic's own three-tier model — but this ADK Skills mechanism augments the *same* agent that discovered the skill; ADK's separate coordinator/subagent collaboration-mode page was not found to state that triggering a Skill causes the coordinator to invoke a subagent. OpenAI's Agents SDK and Microsoft's AutoGen/Semantic Kernel were confirmed in this research to document a subagent/handoff/delegation mechanism only — no Skill-equivalent progressive-disclosure mechanism was found documented for these three frameworks/products in the pages reviewed, so no claim is made that they document "both halves" either combined or separated. Google ADK's collaboration page additionally documents explicit context isolation for its `task`/`single_turn`-mode subagents ("operates in its own isolated session branch... cannot see what its peer agents are doing"; `evidence.csv` row 30), which is direct prior art for the "isolated context window" element specifically, alongside Claude Code, GitHub Copilot, and LangChain subagents — see `prior-art.md` §4/§8. **None of the sources reviewed — including Google ADK's and CrewAI's own Skills documentation, newly reviewed for this update — document a first-class, named feature in which a Skill's own runtime trigger/activation decision causes the parent to invoke a separate, cost-tiered subagent.** This absence finding is narrowly scoped to that specific outer composition; it is not a claim that no vendor documents a Skill-equivalent discovery mechanism (five now do) or that no vendor documents model/tool/skill composition on one agent object (three now do).
2. **No academic paper found** that studies this composition as a unit. The closest academic matches address only one half each: FrugalGPT and RouteLLM address model cascades/routing between cost tiers (not skill-triggered, not tool-scoped); AutoGen addresses multi-agent conversation/delegation generally (not skill-triggered, not explicitly cost-tiered).
3. **No settled informal/gray-literature term** was found either. Community and blog sources used inconsistent, ad hoc phrases for the cheap-model-routing half alone ("Haiku offload," "cheap model," "worker tier," "subagent model downgrade," "cost-control settings"), and none of these sources discuss pairing that routing with a Skill-based discovery/trigger layer specifically. No source used a name that covers the full composition end-to-end.
4. **No first-party documentation found** that explicitly measures or claims a specific token-count savings figure for *tool-schema minimization alone* (as distinct from overall context-length effects). Anthropic's context-engineering post argues qualitatively that bloated tool sets create "ambiguous decision points" and increase maintenance/context burden, and Chroma's "Context Rot" report measures degradation from overall input length — but neither isolates "each additional unused tool definition costs N tokens and Y% accuracy" as a measured figure. The one preprint located that attempts to measure/address this directly (arXiv 2604.21816, "Tool Attention Is All You Need") is very recent (April 2026 per its arXiv identifier) and not peer-reviewed; it is flagged as low-confidence/preliminary in `evidence.csv` rather than treated as an established measurement.
5. **Model Context Protocol (MCP)** was noted only in passing (it is referenced by Anthropic's Agent Skills post as a complementary mechanism) and was not independently researched in depth, since it is orthogonal to the tool-allowlist/subagent composition in scope for this report; this is a deliberate scoping choice, not an oversight, and is called out in `prior-art.md`'s Limitations section.
6. **Anthropic's Agent Skills spec explicitly marks `allowed-tools` as "Experimental"** (per `agentskills.io/specification`) — i.e., even the tool-restriction field on the *skill* side of this composition is not yet a stable, finalized mechanism in the canonical spec, separate from whatever tool-scoping a *subagent/custom-agent* definition provides.
7. No evidence was found — and none was sought — of any patent, trademark, or freedom-to-operate conflict; that kind of legal clearance is out of scope for this research and is explicitly disclaimed in `prior-art.md`.
