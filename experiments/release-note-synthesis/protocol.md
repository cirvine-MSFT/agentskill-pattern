# Release-note synthesis feasibility protocol

## Question and boundary

Could one bounded public-source dossier produce a grounded customer-facing release note
through the Agent Skill Pattern while preserving quality and reducing parent context?

The target A4 route was:

1. GPT-5.6 Sol parent loads `release-note-synthesis`;
2. parent delegates exactly once to fixed `release-note-haiku`;
3. worker calls `read_release_dossier` once;
4. worker calls `write_release_note_draft` once;
5. parent receives only run ID, output path, and integrity metadata.

No shell, search, web, generic file tools, evaluator access, recursive delegation, or
retry was allowed. Gold fact inventories were evaluator-only.

## Planned comparisons

The later design reserved deterministic A0, GPT inline A1, GPT-to-GPT A2, explicit
GPT-to-Haiku A3, and Skill-discovered GPT-to-Haiku A4. A4 versus A1 was the intended
primary comparison. None of these comparative arms was authorized because the
feasibility gate failed; no valid control exists.

## Start and gate rules

After a durable start marker, every crash, timeout, refusal, malformed result, missing
usage record, boundary violation, or partial artifact remained an ITT feasibility
outcome. No started unit could be retried or tuned.

The frozen excluded-pilot gate required all three A4 units to:

- complete one structured read and one structured write;
- produce a valid draft and compact return;
- preserve model, actor, filesystem, and evaluator isolation;
- contain no unsupported critical claim; and
- remain below 20,000 model tokens and 300 seconds.

Passing would only have authorized a separate preregistration, never immediate main
execution.

## Quality and usage

Had drafts existed, an external deterministic fact evaluator and blinded human review
would have measured precision, critical recall, unsupported claims, category,
references, usefulness, clarity, and concision. Parent/worker credits, tokens, timing,
tool behavior, and reliability were separate outcomes. Because no draft was written,
semantic endpoints are unavailable, not zero.
