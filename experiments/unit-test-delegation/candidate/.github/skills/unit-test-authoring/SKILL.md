---
name: unit-test-authoring
description: Routes one bounded unit-test file to the fixed-Haiku test author after production implementation.
---

Require the complete frozen envelope: run ID, requirements path, changed production
file paths, nearby-test paths, precreated target-test path, and status hash. Delegate
exactly once to `unit-test-author-haiku`, forwarding only that envelope.

The parent must finish production implementation before routing. After delegation
returns, the parent must not view, search, run, grade, edit, repair, rewrite, or
describe the target test. It must not retry or invoke another test author. Return only
the worker's compact terminal line. If delegation is unavailable or fails, return:
`<run-id> | <target-test-path> | FAILURE | <status-hash>` and stop.
