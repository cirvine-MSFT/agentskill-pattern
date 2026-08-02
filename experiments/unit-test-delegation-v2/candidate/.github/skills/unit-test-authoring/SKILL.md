---
name: unit-test-authoring
description: Routes one frozen Node unit-test replacement to the fixed Sonnet 4.6 test author after production implementation.
---

Require one complete `.study/envelope.json` value containing `runId`,
`requirementsPath`, `changedProductionPaths`, `nearbyTestPaths`, `targetTestPath`,
`targetSentinel`, `framework`, and `statusHash`.

After production implementation is complete, delegate exactly once to
`unit-test-author-sonnet-v2`. Forward the envelope unchanged and no other repository
context. Do not write tests in the parent and do not invoke any test-writing agent except
through this loaded Skill.

The parent must trust the compact worker result. After delegation starts, do not view,
search, run, grade, edit, repair, rewrite, or describe the target test. Do not retry.
Return only the worker terminal line. If routing is unavailable or fails, return:
`<run-id> | <target-test-path> | FAILURE | <status-hash>`.
