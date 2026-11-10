---
id: ADR-0002
type: decision
status: accepted
domain: system
title: wacli is the WhatsApp engine
# area.name, e.g. dispatch.queue. One accepted decision per key; replacing one needs `supersedes`.
decision_key: engine.wacli
code_paths:
  - src/wacli.ts
supersedes: []
superseded_by: null
---

# ADR-0002 — wacli is the WhatsApp engine

## Question

What talks to WhatsApp: this CLI directly, or an existing client it wraps?

## Outcome

The CLI wraps a pinned [wacli](https://github.com/openclaw/wacli) v0.26.0, linked as a companion device, and runs it only from `src/wacli.ts`: an allowlist of commands by class, one absolute `--store` on every call, `--read-only` on reads, user values as `--flag=value`. The pinned build carries two local patches: quiet presence for `auth` and `history backfill`, and `--delegate-only` for sends (ADR-0003, ADR-0004). The host's package manager pins this repository's commit together with that build.

## Alternatives

| Alternative | Why it lost |
| --- | --- |
| Use whatsmeow directly from a Go helper | Rebuilds session, store, sync and history handling that wacli already has |
| The WhatsApp Business API | Business accounts only; the job is the owner's personal account |

## Premises

- wacli is an unofficial client and carries a ban risk for the owner's number; the owner accepted it on 2026-11-10 for quiet personal reading and rare approved sends, never bulk messaging.
- wacli reports errors as text with exit 1, so the wrapper never classifies a send failure by its text.

## Revisit if

- wacli gets in the way (missing command, unfixable behaviour, abandoned upstream).
- The account is banned or warned.

## Evidence

- reported: wacli v0.26.0 source and docs read on 2026-11-10 (`AGENTS.md`, "What wacli does underneath").
- measured: `src/__tests__/cli.test.ts` "every read passes --read-only and the one absolute --store, and maps wacli fields" and the allowlist check over every invocation.
