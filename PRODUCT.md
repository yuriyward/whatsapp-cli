# whatsapp-cli

**Job:** "When an AI agent works for me on my personal WhatsApp account, I want it to read, search, export and draft through one predictable CLI, so that it can answer about my conversations and prepare replies without ever sending anything I did not approve."

The account is linked as a WhatsApp companion device through [wacli](https://github.com/openclaw/wacli) v0.26.0 (pinned and patched by the host's package manager; ADR-0002). That is an unofficial client and carries a ban risk for the owner's number; the owner accepted it on 2026-11-10 for quiet personal reading and rare approved sends, never bulk messaging.

## Users

| Who | Uses it to |
| --- | --- |
| An AI agent acting for the account owner | Find chats, read and export history, download attachments, keep local drafts, send or react after approval |
| The account owner | Pair once in their own terminal, then approve what the agent sends |

## Never

- **N1** Send a message or set a reaction without `--user-confirmed`, which the agent passes only after the owner approved that exact text, file or emoji for that recipient (ADR-0001; no separate approval broker).
- **N2** Commit session data, exports, journals or message-derived fixtures; tests and examples use synthetic identities (`+1555…`).
- **N3** Pick a recipient by fuzzy or display-name matching; references are exact JIDs, E.164 numbers or saved aliases.
- **N4** Mark anything read, send typing, or go online: reads use `--read-only`, the daemon and every sync run with quiet presence, and no command passes `--receipts` (ADR-0004).
- **N5** Change contacts, privacy, the profile or group administration.

## Declined

- Bulk or scheduled sends, broadcasts, status posts, calls, a scheduled backfill (backfill runs on request: ADR-0005).
- Automatic re-pairing or restarting on heartbeat age.
- Talking to whatsmeow directly; revisit only if wacli gets in the way (ADR-0002).
