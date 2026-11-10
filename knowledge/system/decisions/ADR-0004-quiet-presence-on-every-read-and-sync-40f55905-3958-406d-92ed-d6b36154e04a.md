---
id: ADR-0004
type: decision
status: accepted
domain: system
title: Quiet presence on every read and sync
# area.name, e.g. dispatch.queue. One accepted decision per key; replacing one needs `supersedes`.
decision_key: presence.quiet
code_paths:
  - src/wacli.ts
  - src/reads.ts
supersedes: []
superseded_by: null
---

# ADR-0004 — Quiet presence on every read and sync

## Question

What may the account show to contacts while an agent reads and syncs?

## Outcome

Nothing: no read marks, typing or online presence. Reads run `wacli --read-only` against the local archive; the daemon, pairing and backfill sync with quiet presence (patched in the pinned build); no command passes `--receipts`, `mark-read`, `presence` or `typing`. Contacts, privacy, profile and group administration are out of scope.

## Alternatives

| Alternative | Why it lost |
| --- | --- |
| wacli defaults (available presence on sync) | Shows the owner online whenever the agent syncs |
| Mark chats read after an agent reads them | The owner decides what they have read; a read mark also tells the sender |

## Premises

- Agents read far more often than the owner sends; every read must be invisible to contacts.
- Quiet presence lowers the unofficial-client risk accepted in ADR-0002.

## Revisit if

- The owner wants an agent to mark a chat read on request.

## Evidence

- measured: `src/__tests__/cli.test.ts` assertion over every invocation that no `--receipts`, `--presence-mode`, `mark-read`, `presence` or `typing` argument is passed.
