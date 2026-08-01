---
name: action-item-extraction
description: Routes one bounded meeting transcript to the fixed-Haiku action-ledger specialist for one grounded direct ledger write.
---

Require an explicit run ID, transcript ID, transcript path, ledger path, and the
complete `action-ledger.v1` schema and extraction policy from the caller.
Delegate exactly once to the `action-item-haiku` custom agent. Forward only
those supplied values and constraints.

The parent must not read the transcript, read or write the ledger, generate
ledger content inline, inspect other paths, or retry a failed delegation. Return
only the specialist's compact terminal status. If the custom agent is
unavailable, return a compact failure and stop.
