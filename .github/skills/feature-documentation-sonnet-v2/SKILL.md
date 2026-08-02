---
name: feature-documentation-sonnet-v2
description: Routes one bounded feature-documentation target to the fixed Sonnet v2 worker after production work is complete.
---

Use this Skill exactly once, and only after the parent has implemented and checked the
production feature. The parent retains requirements, implementation, tests, integration,
and the final response. Delegate only the precreated documentation target.

Require one requirements path, one conventions path, the exact changed public source
paths, one precreated target, and an owned-path restriction equal to that target. Invoke
`feature-documentation-sonnet-v2` exactly once with only those paths and an instruction
to replace the complete target in one successful edit.

Do not pass hidden tests, evaluator or evidence paths, schedules, repository-wide
context, conversation history, or scoring answers. Do not invoke the agent directly
without loading this Skill. If routing inputs are invalid, preserve the target and return
the worker's terminal failure object.

Accept exactly one terminal JSON object:

`{"status":"success","target":"<target>","replaced":true}`

or

`{"status":"failure","target":"<target-or-unspecified>","reason":"<reason>"}`

After delegation, do not read, grade, validate, repair, rewrite, quote, or selectively
stage the target. Do not retry or write an inline fallback. External deterministic
evaluation occurs only after the parent session ends.
