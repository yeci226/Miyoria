# Product

<!-- impeccable:product-schema 1 -->

<!-- Inferred from the owner's redesign brief and the repository (no interview round was possible
in this session); the V3 direction was approved by the owner on 2026-11-07, see
docs/design/v3-architecture.md §17. -->

## Platform

web

## Users

One owner (writes Traditional Chinese) who runs the AI VTuber DeepSeek-chan, glancing at the
panel on a streaming desk at night beside Discord, OBS, VTube Studio and a terminal. Optional
Discord-login moderators, some read-only (no `admin.panel.write`).

## Product Purpose

The admin panel of the Miyoria Core: see whether she is healthy, what she heard and decided,
steer the live show (voice channel, Go Live, scene, expression, stream, songs, game, queue,
how much she talks per channel, say a line, emergency stop), see how she has been over time
(mood, drives, thoughts, conversations, LLM use), and edit who she is
(persona, memories, relationships) and who may do what (roles).

## Operating Context

Served by the Core from `apps/panel/dist` on `127.0.0.1:7878` (hash routes). One SSE stream of
bus events feeds live views. Login by admin bearer token or Discord OAuth (cookie + CSRF header).
It runs on the same machine as TTS and ASR, so every glass effect can be turned down or off.

## Capabilities and Constraints

- UI copy is zh-TW. Ids, topics, JSON and tokens stay in their original form.
- Every write is audited by the Core; read-only accounts see changes disabled, not hidden.
- Live services run elsewhere; the panel must tolerate stopped modules (503) and a missing stage node.
- Appearance is a per-browser preference: settings in `localStorage`, the owner's picture in
  IndexedDB. Nothing about it reaches the Core.
- The owner's background picture is copyrighted game art. No such image ships with the panel or
  enters the repository: the default is a built-in gradient and the owner adds a picture in the
  appearance popover.
- Pages show real data only. Anything the Core cannot serve yet stays out of the panel.

## Brand Commitments

- Owner's binding direction: a restrained operating tool of see-through dark glass over a real
  picture, Geist, shadcn/ui primitives. Reference points are the AIRI site and Vercel Geist.
- Two accents and no more: a primary (pink by default) and a secondary (violet by default), chosen
  together as a pair. Everything else is neutral. Red is the emergency stop and nothing else.
- Rejected, and not to come back: oversized headings, big-number tiles, soft-shadow rounded cards,
  floating panels, glow, gradient text, a third accent, a kicker above a heading.
- No subtitles or descriptions under page and section titles, no joke or advice copy in empty states.
- Character name DeepSeek-chan; "她" refers to her in the UI.

## Product Principles

1. State first: what is wrong, and what is live, is visible without reading prose.
2. Every control does something real; nothing is shown that the Core cannot do.
3. Depth comes from surface weight, not from boxes: picture, content, frame, darker band.
4. Quiet chrome, dense data, one line where one line is enough.
