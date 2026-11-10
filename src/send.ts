import { randomUUID } from "node:crypto";
import path from "node:path";
import { allowOnly, messageId, one, type Parsed, shellQuote } from "./args.ts";
import { claimDraft, type Content, CONTENT_FLAGS, content, deleteDraft, dispatchedError, loadDraft, preview } from "./drafts.ts";
import { CliError, EXIT, usage } from "./errors.ts";
import type { Ctx, Output } from "./reads.ts";
import { resolveChat } from "./refs.ts";
import { appendLine } from "./state.ts";
import { type WacliCommand, WacliError } from "./wacli.ts";

/**
 * N1: without --user-confirmed nothing is sent; the error shows what would go and the exact command with the flag.
 * The flag is the agent's statement that the owner approved this exact content and recipient (ADR-0001).
 */
function requireConfirmation(parsed: Parsed, argv: string[], summary: string) {
  if (parsed.bools.has("user-confirmed")) {
    return;
  }
  throw new CliError("confirmation_required", `Not sent. Show the owner exactly this and get approval:\n${summary}`, {
    exitCode: EXIT.usage,
    recovery: `whatsapp-cli ${[...argv.filter((a) => a !== "--json"), "--user-confirmed"].map(shellQuote).join(" ")}`,
  });
}

interface Attempt {
  attempt: string;
  kind: "text" | "file" | "react";
  chat: string;
  record: Record<string, unknown>;
  command: WacliCommand;
  args: string[];
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * One dispatch to the running daemon, journalled before and after. Everything up to spawning wacli is
 * checked first: a failure there (or a spawn failure) is known unsent and rethrown as is. A failure once
 * wacli runs is `outcome_unknown` and is never retried: wacli reports only text, so no failure proves "not sent".
 */
async function dispatch(ctx: Ctx, a: Attempt) {
  const journal = path.join(ctx.paths.state, "journal.jsonl");
  const { attempt } = a;
  const at = () => ctx.deps.now().toISOString();
  ctx.wacli.requireStore();
  await ctx.wacli.requireDaemon(a.kind === "react" ? "Reacting" : "Sending");
  const argv = ctx.wacli.prepare(a.command, a.args);
  await appendLine(journal, { at: at(), attempt, chat: a.chat, kind: a.kind, outcome: "dispatching", ...a.record });
  let data: { sent?: unknown; id?: unknown; store_warning?: unknown };
  try {
    data = ((await ctx.wacli.run(a.command, argv)) ?? {}) as typeof data;
    if (data.sent !== true || typeof data.id !== "string") {
      throw new CliError("wacli_failed", "wacli returned no sent message id");
    }
  } catch (error) {
    const reason = message(error);
    if (error instanceof CliError && error.code === "wacli_not_started") {
      await appendLine(journal, { at: at(), attempt, error: reason, outcome: "not_sent" }).catch(() => undefined);
      throw error;
    }
    // The transport outcome wins over bookkeeping: a failed append never turns this into another error.
    const journalWarning = await appendLine(journal, { at: at(), attempt, error: reason, outcome: "outcome_unknown" }).then(
      () => null,
      (e: unknown) => `journal not updated: ${message(e)}`,
    );
    throw new CliError("outcome_unknown", `The ${a.kind} may or may not have gone out: ${reason}`, {
      details: { attempt, ...(journalWarning ? { journalWarning } : {}) },
      recovery: `Do not resend. Check first: whatsapp-cli messages read --chat ${a.chat} --since today (and the owner's phone)`,
    });
  }
  const warnings: string[] = [];
  if (typeof data.store_warning === "string") {
    warnings.push(`wacli could not record it locally: ${data.store_warning}`);
  }
  await appendLine(journal, { at: at(), attempt, id: data.id, outcome: "sent" }).catch((e: unknown) =>
    warnings.push(`journal not updated (attempt ${attempt}): ${message(e)}`),
  );
  return { attempt, id: data.id, warnings };
}

/**
 * Pinned-build flag (local delegate-only patch, ADR-0003): wacli hands the send to the running daemon or
 * fails; it never takes the store lock, connects or sends with normal presence itself, even if the daemon
 * stops after requireDaemon. requireDaemon stays for the friendly daemon_not_running error.
 */
const DELEGATE_ONLY = "--delegate-only";

function sendArgs(chat: string, c: Content, replyTo: string | null, allowSelf: boolean): { command: WacliCommand; args: string[] } {
  const reply = replyTo ? [`--reply-to=${replyTo}`] : [];
  if (c.kind === "text") {
    return { args: [DELEGATE_ONLY, `--to=${chat}`, `--message=${c.text}`, ...reply, ...(allowSelf ? ["--allow-self"] : [])], command: "send text" };
  }
  if (allowSelf) {
    throw usage("--allow-self applies to text sends only");
  }
  return { args: [DELEGATE_ONLY, `--to=${chat}`, `--file=${c.file}`, ...(c.caption ? [`--caption=${c.caption}`] : []), ...reply], command: "send file" };
}

export async function messagesSend(ctx: Ctx, parsed: Parsed, argv: string[]): Promise<Output> {
  allowOnly(parsed, ["chat", "draft", "reply-to", "user-confirmed", "allow-self", ...CONTENT_FLAGS]);
  const draftId = one(parsed, "draft");
  const attempt = randomUUID();
  if (draftId && ["chat", "reply-to", ...CONTENT_FLAGS].some((f) => parsed.flags.has(f))) {
    throw usage("--draft sends the stored draft as is; pass no --chat, --reply-to or content flags");
  }
  // A confirmed draft send claims the draft before reading it; only one process can hold the claim.
  const release = draftId && parsed.bools.has("user-confirmed") ? await claimDraft(ctx, draftId, attempt, ctx.deps.now().toISOString()) : undefined;
  try {
    let chat: string;
    let c: Content;
    let replyTo: string | null;
    if (draftId) {
      const draft = await loadDraft(ctx, draftId);
      if (!release && draft.dispatched) {
        throw dispatchedError(draftId, draft.dispatched);
      }
      ({ chat, content: c, replyTo } = draft);
    } else {
      chat = await resolveChat(ctx.paths.state, one(parsed, "chat", true));
      c = await content(ctx, parsed);
      const reply = one(parsed, "reply-to");
      replyTo = reply ? messageId(reply) : null;
    }
    requireConfirmation(parsed, argv, preview(chat, c, replyTo));
    const { command, args } = sendArgs(chat, c, replyTo, parsed.bools.has("allow-self"));
    const record = { ...(c.kind === "text" ? { text: c.text } : { caption: c.caption, file: c.file }), draft: draftId ?? null, replyTo };
    const sent = await dispatch(ctx, { args, attempt, chat, command, kind: c.kind, record });
    if (draftId) {
      await deleteDraft(ctx, draftId).catch((e: unknown) =>
        sent.warnings.push(`draft ${draftId} not fully deleted (${message(e)}); its claim keeps it from being sent again (attempt ${sent.attempt})`),
      );
    }
    return sentOutput({ chat, id: sent.id, sent: true }, `sent to ${chat} (id ${sent.id}); accepted by WhatsApp, delivery not confirmed`, sent.warnings);
  } catch (error) {
    // Kept only when the send may have happened; every other failure is known unsent and frees the draft.
    if (release && !(error instanceof CliError && error.code === "outcome_unknown")) {
      await release();
    }
    throw error;
  }
}

/** Known success, with any bookkeeping that failed after it; never a reason to resend. */
function sentOutput(json: Record<string, unknown>, text: string, warnings: string[]): Output {
  return {
    json: { ...json, persistenceWarnings: warnings },
    text: `${text}\n${warnings.map((w) => `warning: sent, do not resend; ${w}\n`).join("")}`,
  };
}

const EMOJI = /^(?=.*\p{Extended_Pictographic})[\p{Extended_Pictographic}\p{Emoji_Component}‍️]{1,16}$/u;
const USER_JID = /^[0-9]{5,20}(?::[0-9]{1,3})?@(s\.whatsapp\.net|lid)$/;

/**
 * The target's author, from the local archive. wacli `send react` without --sender builds a key with
 * FromMe=true (whatsmeow BuildMessageKey), so a reaction to an incoming message pointed at a nonexistent
 * own message and never showed (live, 2026-11-10). Own messages need no sender; an unknown target is
 * refused rather than guessed.
 */
async function reactionSender(ctx: Ctx, chat: string, id: string): Promise<string | null> {
  const unknown = (why: string) =>
    new CliError("reaction_target_unknown", `Message ${id} in ${chat} ${why}, so its author is unknown; nothing was sent`, {
      exitCode: EXIT.notFound,
      recovery: `Find it with whatsapp-cli messages read --chat ${chat} --since all, or pass --sender <author jid> explicitly`,
    });
  let m: { FromMe?: unknown; SenderJID?: unknown } | null;
  try {
    m = (await ctx.wacli.call("messages show", [`--chat=${chat}`, `--id=${id}`])) as typeof m;
  } catch (error) {
    if (error instanceof WacliError) {
      throw unknown(`is not in the local archive (${error.message})`);
    }
    throw error;
  }
  if (!m) {
    throw unknown("is not in the local archive");
  }
  if (m.FromMe === true) {
    return null;
  }
  if (typeof m.SenderJID !== "string" || !USER_JID.test(m.SenderJID)) {
    throw unknown(`has no usable sender JID (${JSON.stringify(m.SenderJID ?? null)})`);
  }
  return m.SenderJID;
}

export async function messagesReact(ctx: Ctx, parsed: Parsed, argv: string[]): Promise<Output> {
  allowOnly(parsed, ["chat", "id", "emoji", "sender", "user-confirmed"]);
  const chat = await resolveChat(ctx.paths.state, one(parsed, "chat", true));
  const id = messageId(one(parsed, "id", true));
  const emoji = one(parsed, "emoji", true);
  if (!EMOJI.test(emoji)) {
    throw usage("--emoji must be one standard emoji");
  }
  const explicit = one(parsed, "sender");
  if (explicit !== undefined && !USER_JID.test(explicit)) {
    throw usage("--sender must be the message author's user JID from messages read");
  }
  const sender = explicit ?? (await reactionSender(ctx, chat, id));
  requireConfirmation(parsed, argv, `react ${emoji} to message ${id} ${sender ? `from ${sender}` : "(your own)"} in ${chat}\n`);
  const args = [DELEGATE_ONLY, `--to=${chat}`, `--id=${id}`, `--reaction=${emoji}`, ...(sender ? [`--sender=${sender}`] : [])];
  const sent = await dispatch(ctx, { args, attempt: randomUUID(), chat, command: "send react", kind: "react", record: { emoji, sender: sender ?? null, target: id } });
  return sentOutput({ chat, emoji, id: sent.id, sent: true, target: id }, `reacted ${emoji} to ${id} in ${chat}`, sent.warnings);
}
