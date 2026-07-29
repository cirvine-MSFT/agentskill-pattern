---
name: ascii-art
description: Routes bounded requests to generate or update ASCII banners and other ASCII-art assets during larger repository tasks. Use when text art must be written to a file under explicit size, character, style, and integration constraints.
---

Invoke the `ascii-art` custom agent with a bounded prompt containing the target file
path, required text, maximum width and height, allowed characters, style, integration
constraints, and owned paths. Do not add shell/search verification or override the
agent's terse return contract.

Do not generate or edit the art yourself. If the custom agent is unavailable, report
that delegation is unavailable; do not fall back to inline generation.
