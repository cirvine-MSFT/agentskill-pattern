---
name: semantic-test-corpus
description: Invoke the confined semantic-test-corpus agent with the common benchmark task.
---

Invoke the `semantic-test-corpus` custom agent exactly once with
`task/shared-task-prompt.txt` without additions or omissions. The worker inherits the
authenticated parent/session model binding. Its only tools are the four configured
`semantic-corpus/*` MCP tools.

Return only the agent's exact terminal line:
`corpus-staging/manifest.json - <count> scenarios - SUCCESS` or
`corpus-staging - <written-count> scenarios - FAILURE: <reason>`.
Do not return corpus content or synthesized metadata through the parent conversation.
The parent must not call the MCP tools, inspect staging, validate, promote, or retry.
