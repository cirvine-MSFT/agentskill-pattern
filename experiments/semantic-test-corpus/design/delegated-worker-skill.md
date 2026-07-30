---
name: semantic-scenario-stager
description: Generate semantic migration scenario inputs directly into the coordinator-owned staging file.
---

Use `task/shared-task-prompt.txt` without additions or omissions. Write only the
60 scenario inputs to the exact staging path supplied by the coordinator. Do not
return corpus content through the parent conversation and do not read outside
the materialized candidate root. Run `node scripts/validate-staging.mjs <path>`.
Return exactly one JSON object containing `stagingPath`, `payloadSha256`,
`submittedCases`, `promotableCases`, and `errorCount`.

The permitted tool surface is file read, file write, and the staging validator.
Network access and evaluator paths are unavailable.
