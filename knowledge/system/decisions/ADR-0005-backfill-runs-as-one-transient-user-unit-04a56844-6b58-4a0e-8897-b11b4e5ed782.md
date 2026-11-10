---
id: ADR-0005
type: decision
status: accepted
domain: system
title: Backfill runs as one transient user unit
# area.name, e.g. dispatch.queue. One accepted decision per key; replacing one needs `supersedes`.
decision_key: history.backfill
code_paths:
  - src/backfill.ts
supersedes: []
superseded_by: null
---

# ADR-0005 — Backfill runs as one transient user unit

## Question

How does `history backfill` get the writable store, which the daemon holds and does not delegate, without leaving the daemon stopped?

## Outcome

`history backfill` runs `systemd-run --user --wait --unit=wacli-backfill`: `ExecStartPre` stops `wacli-sync`, the unit runs one backfill, and `ExecStopPost` runs `reset-failed` then starts `wacli-sync`. systemd, not this process, restarts the daemon even if the wrapper is killed; the fixed unit name allows one backfill at a time (`backfill_running`). Output goes to a per-run directory `<state>/backfill/<uuid>/`; a backfill is refused while the service is down, so it never interrupts the initial history capture after pairing.

## Alternatives

| Alternative | Why it lost |
| --- | --- |
| Stop, backfill and start from the wrapper process | A killed wrapper leaves the daemon stopped |
| A scheduled backfill | Declined: backfill runs only on request while the phone is online |

## Premises

- The user service has a start limit (3 per hour); `reset-failed` keeps maintenance restarts out of it.
- `ExecStopPost` output truncates `truncate:` files, so output uses `append:`.

## Revisit if

- wacli gains backfill delegation through the daemon.

## Evidence

- measured: on a systemd user manager, 2026-11-10: client killed mid-run, sync restarted when the job ended; five starts against `StartLimitBurst=3` all succeeded.
- measured: `src/__tests__/cli.test.ts` "runs stop -> backfill -> reset-failed -> start as one transient unit" and "a second backfill is refused while one runs, without touching the service".
