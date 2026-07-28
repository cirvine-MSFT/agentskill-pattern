# Pattern diagrams

Each diagram is preserved as an editable Excalidraw source and a README-ready PNG export. Open the `.excalidraw` files in the Microsoft internal Excalidraw instance at [aka.ms/excalidraw](https://aka.ms/excalidraw). The PNGs were exported from those sources with a white background at 1x scale.

## Discovery and invocation

[![Agent Skill discovery and invocation flow](discovery-and-invocation.png)](discovery-and-invocation.excalidraw)

- **Editable source:** [`discovery-and-invocation.excalidraw`](discovery-and-invocation.excalidraw)
- **PNG export:** [`discovery-and-invocation.png`](discovery-and-invocation.png)
- **Alt text:** A left-to-right flow begins with a user request and a GPT-5.6 Sol parent inside an agent harness. The harness exposes Agent Skill metadata through progressive disclosure and also exposes a named custom subagent. The skill converts intent into tiny routing instructions that name the diagram-specialist delegate. The subagent performs the bounded work and returns a compact result. A caption emphasizes that the harness exposes options while the skill connects user intent to precise delegation.

## Context and cost boundary

[![Parent and specialist context boundaries](context-and-cost-boundary.png)](context-and-cost-boundary.excalidraw)

- **Editable source:** [`context-and-cost-boundary.excalidraw`](context-and-cost-boundary.excalidraw)
- **PNG export:** [`context-and-cost-boundary.png`](context-and-cost-boundary.png)
- **Alt text:** Two side-by-side context boundaries compare a GPT-5.6 Sol parent with a Claude Haiku 4.5 specialist. The parent keeps the full request, repository state, and orchestration context, sending only a bounded task and receiving a compact return. The specialist receives a narrow prompt and only read and edit tool schemas, writes the asset directly to the workspace, and returns terse status. The primary purpose is context efficiency, focus, and lower cost; safety through least privilege is shown as a secondary benefit.
