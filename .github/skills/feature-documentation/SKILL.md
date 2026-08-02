---
name: feature-documentation
description: Delegates one bounded user-facing feature guide or example artifact after the parent implements the feature.
---

Use this Skill only after the parent has completed the requested production feature and
integration work. The parent owns requirements, implementation, tests, and its final
response. Delegate only the documentation target.

Before delegation, require:

- one precreated documentation target;
- the bounded feature requirement file;
- the exact changed public source/API files the worker may read;
- one nearby documentation-conventions file; and
- an owned-path restriction equal to the target.

Invoke `feature-documentation-haiku` once with only those paths and the instruction to
write the target directly. Do not pass hidden tests, evaluator material, conversation
history, repository-wide context, or acceptance answers. If any required input is
missing, report failure instead of writing documentation inline.

After invocation, accept only `<target> - SUCCESS` or `<target> - FAILURE: <reason>`.
The parent must not read, grade, validate, repair, rewrite, stage selectively, or quote
the delegated target after the call. On failure, do not retry or replace the artifact.
External deterministic evaluation occurs only after the parent session ends.
