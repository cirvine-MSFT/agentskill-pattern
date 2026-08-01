---
name: release-note-synthesis
description: Routes one bounded public PR/issue dossier to the fixed-Haiku release-note specialist for one direct customer-facing draft write.
---

Use this Skill only when the task supplies one immutable release dossier and asks for one
customer-facing release-note draft. Invoke `release-note-haiku` exactly once and pass the
task envelope unchanged.

The specialist owns the entire dossier read and draft write. Do not read the dossier,
draft inline, call its MCP tools from the parent, browse the repository, search the web,
or invoke another agent. If the specialist cannot complete the task with one
`read_release_dossier` call and one `write_release_note_draft` call, preserve the failure.

Return only the specialist's compact JSON status envelope. It may contain `runId`,
`outputPath`, and `integrity`; it must not contain dossier or draft content.
