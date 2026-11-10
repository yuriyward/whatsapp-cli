---
id: ADR-0001
type: decision
status: accepted
domain: system
title: Sending and reacting need explicit user confirmation
# area.name, e.g. dispatch.queue. One accepted decision per key; replacing one needs `supersedes`.
decision_key: send.confirmation
code_paths:
  - src/send.ts
  - src/drafts.ts
supersedes: []
superseded_by: null
---

# ADR-0001 — Sending and reacting need explicit user confirmation

## Question

How does the CLI keep an agent from sending messages or reactions the account owner did not approve?

## Outcome

`messages send` and `messages react` refuse to run without `--user-confirmed`. The flag is the agent's statement that the owner approved this exact text, file or emoji for this recipient in the current conversation; reads, exports, drafts and requests to reply never imply it. Without the flag nothing reaches wacli, and the error prints what would go and the exact command with the flag.

## Alternatives

| Alternative | Why it lost |
| --- | --- |
| No send command; the owner sends by hand | Copying approved replies into WhatsApp by hand is the friction the CLI removes |
| An interactive prompt before each send | Agents run non-interactively; a prompt either blocks or gets answered by the agent itself |
| A separate approval broker | One more service to run for a rare action; the flag is auditable in the journal and the conversation |

## Premises

- A sent message goes out under the owner's name and cannot be taken back; a reaction can notify the other person.
- The CLI cannot see the conversation where approval happened, so it can only demand an explicit, auditable flag.

## Revisit if

- An agent sends with the flag where the owner had not approved.
- A standing approval (an owner-approved workflow for a recipient and case) needs to be checked by the CLI itself.

## Evidence

- measured: `src/__tests__/cli.test.ts` "without --user-confirmed nothing reaches wacli and the exact command is printed"; `src/send.ts` `requireConfirmation`.
- reported: the same convention as the owner's Telegram CLI, which the owner chose for this repository on 2026-11-10.
