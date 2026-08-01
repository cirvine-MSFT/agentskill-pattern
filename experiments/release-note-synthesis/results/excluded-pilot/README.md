# Excluded feasibility pilot evidence

This directory is write-once evidence for the three A4 feasibility runs named in
`design/pilot-gate.json`. Every artifact here is permanently excluded from a later
confirmatory study.

The frozen disposition is **NO-GO (0/3)**. The Skill and fixed-Haiku lifecycle appeared,
but the worker's allowlisted MCP names were rejected and it emitted pseudo tool calls and
fabricated draft content as assistant text. No MCP read/write or draft artifact occurred;
all runs exceeded the token cap; compact-return and runtime-isolation requirements also
failed. `scripts/audit-captured-pilot.mjs` deterministically records the independent
post-run findings without changing original evidence. The pilot must not be retried,
tuned, repaired, or relabeled.
