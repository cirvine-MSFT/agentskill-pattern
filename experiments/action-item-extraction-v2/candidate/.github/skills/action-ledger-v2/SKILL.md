---
name: action-ledger-v2
description: Routes one bounded v2 meeting transcript exactly once to the fixed-Haiku action-ledger specialist for one grounded direct ledger replacement.
---

Require the caller's run ID, transcript ID, transcript path, precreated ledger
path, exact ledger sentinel, frozen status hash, schema, and policy.
Route exactly once by delegating
exactly once to the `action-ledger-v2-haiku` custom agent. Forward only that
task envelope.

The parent must not view the transcript, view or edit the ledger, generate
ledger content, inspect another path, or retry. Return only the specialist's
compact terminal line. If delegation is unavailable or fails, return one
compact failure line and stop.
