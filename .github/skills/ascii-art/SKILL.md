---
name: ascii-art
description: Routes bounded requests to generate or update ASCII banners and other ASCII-art assets during larger repository tasks. Use when an asset has explicit text, dimension, character, whitespace, or style constraints.
---

Before delegation, use parent tools to ensure the target's parent directory exists. If
preparation fails, report the error and stop; never generate the art inline.

Invoke the `ascii-art` custom agent with only the target path, any supplied owned-path
restriction, and a complete, explicit enumeration of every original asset-local
constraint: required text; any exact, minimum, or maximum line-count and width limits;
allowed characters; whitespace, trailing-space, and final-newline rules; style; and any
others. Forward only supplied constraints; invent none. After the specialist returns,
the parent performs integration and source verification; never pass them to the
specialist.

If the custom agent is unavailable, report that delegation is unavailable and stop.
