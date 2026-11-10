---
id: ADR-0003
type: decision
status: accepted
domain: system
title: Sends are delegate-only through the daemon
# area.name, e.g. dispatch.queue. One accepted decision per key; replacing one needs `supersedes`.
decision_key: send.delegation
code_paths:
  - src/send.ts
  - src/wacli.ts
supersedes: []
superseded_by: null
---

# ADR-0003 — Sends are delegate-only through the daemon

## Question

How does a send reach WhatsApp while the `wacli-sync` daemon holds the store, without a second session that would go online?

## Outcome

Every `send text`, `send file` and `send react` passes `--delegate-only` (a patch in the pinned build): wacli hands the send to the running daemon over `<store>/.send.sock` or fails, and never takes the store lock or connects itself. Before dispatch the wrapper checks that the `wacli-sync` user service is active and the socket exists, for a clear `daemon_not_running`; any failure after dispatch is `outcome_unknown` and is never retried.

## Alternatives

| Alternative | Why it lost |
| --- | --- |
| Upstream behaviour: send through the daemon if present, else open a session | With no daemon, upstream connects with normal presence (online), breaking ADR-0004 |
| Stop the daemon and send from a fresh session | Interrupts history capture and goes online |

## Premises

- The daemon runs with quiet presence, so delegated sends inherit it.
- A daemon can stop between the wrapper's check and the send; only fail-closed delegation keeps that case quiet.

## Revisit if

- Upstream wacli gains an equivalent of `--delegate-only`, so the patch can go.

## Evidence

- measured: `src/__tests__/cli.test.ts` "with no daemon the send is refused and wacli send never runs" and "file sends pass --delegate-only too, and a daemon gone after the check fails closed as outcome_unknown".
- reported: wacli v0.26.0 `cmd/wacli/send.go` `tryDelegateSend`, `send_ipc.go` (read 2026-11-10).
