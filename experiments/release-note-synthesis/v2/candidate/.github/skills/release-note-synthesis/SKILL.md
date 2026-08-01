---
name: release-note-synthesis
description: Routes one bounded public PR/issue dossier to the fixed-Haiku release-note specialist for one direct customer-facing draft write.
---

Use this Skill only for the supplied immutable release dossier and one customer-facing
release-note draft. Invoke `release-note-haiku` exactly once and pass the task envelope
unchanged.

The specialist owns the complete dossier read and draft write. Do not read the dossier,
draft inline, call its MCP tools from the parent, browse files, search, use the web, or
invoke any other agent. Preserve a rejected or incomplete attempt without retrying.

Return exactly the specialist's compact JSON status envelope. It may contain only
`runId`, `outputPath`, and `integrity`.
