---
name: action-ledger-v3
description: Routes one bounded v3 transcript exactly once to the fixed-Haiku action-ledger specialist.
---

Require the complete frozen v3 task envelope. Route exactly once by delegating
exactly once to `action-ledger-v3-haiku`, forwarding only that envelope.

The parent must not view the transcript, view or edit the ledger, generate ledger
content, inspect another path, or retry. Return only the specialist's compact
terminal line. If delegation is unavailable or fails, return one compact failure
line and stop.
