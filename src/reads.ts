import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { allowOnly, integer, messageId, one, type Parsed, shellQuote } from "./args.ts";
import type { Deps, Paths } from "./deps.ts";
import { local, range, wacliBounds } from "./dates.ts";
import { CliError } from "./errors.ts";
import { aliasesByChat, resolveChat } from "./refs.ts";
import { privateDir } from "./state.ts";
import { SERVICE, Wacli } from "./wacli.ts";

export interface Output {
  json: Record<string, unknown>;
  text: string;
}
export interface Ctx {
  deps: Deps;
  paths: Paths;
  wacli: Wacli;
}

/** wacli's message row, as `messages list|search|export --json` return it. */
export interface WacliMessage {
  ChatJID: string;
  ChatName?: string;
  MsgID: string;
  SenderJID?: string;
  SenderName?: string;
  Timestamp: string;
  FromMe: boolean;
  Text?: string;
  DisplayText?: string;
  ReactionToID?: string;
  ReactionEmoji?: string;
  MediaType?: string;
  MediaCaption?: string;
  Filename?: string;
  MimeType?: string;
  Snippet?: string;
}
export interface Page {
  messages: WacliMessage[] | null;
  page?: { has_more?: boolean; next_cursor?: string | null };
}

/** The fields an agent acts on; wacli's internal paths and hashes stay out. */
export function message(m: WacliMessage) {
  return {
    at: m.Timestamp,
    chat: m.ChatJID,
    fromMe: m.FromMe,
    id: m.MsgID,
    sender: m.SenderJID ?? null,
    senderName: m.SenderName || null,
    text: m.Text ?? m.DisplayText ?? "",
    ...(m.MediaType ? { media: { caption: m.MediaCaption || null, filename: m.Filename || null, mime: m.MimeType || null, type: m.MediaType } } : {}),
    ...(m.ReactionToID ? { reaction: { emoji: m.ReactionEmoji ?? "", to: m.ReactionToID } } : {}),
  };
}
export function line(m: WacliMessage, tz: string) {
  const who = m.FromMe ? "me" : m.SenderName || m.SenderJID || "?";
  const media = m.MediaType ? ` [${m.MediaType}${m.Filename ? ` ${m.Filename}` : ""}]` : "";
  const reaction = m.ReactionToID ? ` [reacted ${m.ReactionEmoji ?? ""} to ${m.ReactionToID}]` : "";
  const text = (m.Text ?? m.DisplayText ?? "").replaceAll("\n", "\n    ");
  return `${local(m.Timestamp, tz)} ${who} (${m.MsgID}):${media}${reaction} ${text}\n`;
}

const continuation = (base: string[], cursor: string) => `whatsapp-cli ${[...base, "--cursor", cursor].map(shellQuote).join(" ")}`;

export async function authStatus(ctx: Ctx, parsed: Parsed): Promise<Output> {
  allowOnly(parsed, []);
  const status = existsSync(ctx.paths.store)
    ? (((await ctx.wacli.call("auth status", [])) ?? {}) as { authenticated?: boolean; linked_jid?: string; phone?: string })
    : { authenticated: false };
  const daemon = await ctx.wacli.daemonRunning();
  const authenticated = status.authenticated === true;
  const json = { authenticated, daemon: daemon ? "running" : "stopped", linkedJid: status.linked_jid ?? null, store: ctx.paths.store };
  const next = !authenticated ? "\ntry: whatsapp-cli auth pair-command (the owner pairs in their own terminal)" : !daemon ? `\ntry: systemctl --user start ${SERVICE}` : "";
  return { json, text: `authenticated: ${authenticated ? `yes (${status.linked_jid ?? "?"})` : "no"}\ndaemon ${SERVICE}: ${json.daemon}${next}\n` };
}

const FIVE_GB = 5 * 1024 ** 3;
/** Checks the owner's preconditions and prints the pairing command; it never runs it. */
export async function authPairCommand(ctx: Ctx, parsed: Parsed): Promise<Output> {
  allowOnly(parsed, []);
  const { store } = ctx.paths;
  if (existsSync(store)) {
    ctx.wacli.requireStore(false);
    const status = ((await ctx.wacli.call("auth status", [])) ?? {}) as { authenticated?: boolean };
    if (status.authenticated) {
      throw new CliError("already_paired", `${store} already holds a paired session; never pair it again automatically`, {
        recovery: "whatsapp-cli auth status",
      });
    }
  }
  if (await ctx.wacli.daemonRunning()) {
    throw new CliError("daemon_running", `${SERVICE} is running; pairing runs alone on the store`, { recovery: `systemctl --user stop ${SERVICE}` });
  }
  const parent = existsSync(store) ? store : path.dirname(store);
  const free = await ctx.deps.freeBytes(existsSync(parent) ? parent : path.dirname(parent));
  if (free < FIVE_GB) {
    throw new CliError("disk_low", `${(free / 1024 ** 3).toFixed(1)} GB free on the store's filesystem; pairing requires at least 5 GB free (a precondition, not a guarantee that the archive fits)`, {
      recovery: "Free disk space, then rerun whatsapp-cli auth pair-command",
    });
  }
  const log = path.join(store, "auth.log");
  // No history caps: --history-days and --history-size-mb default to 0, "no limit, what the phone decides"
  // (wacli v0.26.0 cmd/wacli/auth.go:76,79), and SetHistorySyncLimits sends a limit only when it is > 0
  // (internal/wa/client.go:160-179). The phone still decides what it sends; docs/auth.md saw a personal
  // account stop at about 50 MB without --history-size-mb.
  const command = `mkdir -p -m 700 ${store} && wacli --store ${store} auth --follow --full-history 2> >(tee -a ${log} >&2)`;
  const steps = [
    `Run in your own terminal (not an agent); keep the phone online and charging. ${(free / 1024 ** 3).toFixed(1)} GB are free; 5 GB is the minimum to start, not a guarantee the archive fits.`,
    command,
    "Scan the QR in WhatsApp > Linked devices. The phone decides how much history it sends (no caps are requested). When 'Processing history sync' lines have stopped for 30 minutes, Ctrl+C: that is a handoff heuristic, not completion.",
    `systemctl --user start ${SERVICE} promptly: initial history capture is still ongoing, and chunks the phone has not sent yet arrive on wacli-sync's connections without pairing again.`,
    "whatsapp-cli auth status",
    "Then enable wacli-sync at boot in the host's configuration, so the service survives reboots.",
  ];
  return { json: { capture: "ongoing after handoff; never reported complete", command, freeBytes: free, log, steps }, text: `${steps.join("\n")}\n` };
}

export async function chatsList(ctx: Ctx, parsed: Parsed): Promise<Output> {
  allowOnly(parsed, ["search", "unread", "limit"]);
  const limit = integer(parsed, "limit", 50, 1, 100);
  const search = one(parsed, "search");
  const args = [`--limit=${limit + 1}`, ...(search ? [`--query=${search}`] : []), ...(parsed.bools.has("unread") ? ["--unread"] : [])];
  const rows = ((await ctx.wacli.call("chats list", args)) ?? []) as { jid: string; kind: string; name?: string; last_message_ts?: string; unread?: boolean; unread_count?: number; archived?: boolean }[];
  const aliases = await aliasesByChat(ctx.paths.state);
  const chats = rows.slice(0, limit).map((c) => ({
    aliases: aliases.get(c.jid) ?? [],
    archived: c.archived === true,
    jid: c.jid,
    kind: c.kind,
    lastMessageAt: c.last_message_ts ?? null,
    name: c.name || null,
    unread: c.unread === true,
    unreadCount: c.unread_count ?? 0,
  }));
  const complete = rows.length <= limit;
  const text = chats
    .map((c) => `${c.jid} ${c.kind} ${JSON.stringify(c.name ?? "")}${c.aliases.length ? ` alias:${c.aliases.join(",")}` : ""}${c.unread ? ` unread:${c.unreadCount}` : ""}${c.lastMessageAt ? ` last:${c.lastMessageAt}` : ""}\n`)
    .join("");
  return { json: { chats, complete, count: chats.length }, text: `${chats.length} chats${complete ? "" : ` (more: raise --limit up to 100 or narrow --search)`}\n${text}` };
}

/** One bounded page of a chat, newest page first and printed oldest first. */
export async function messagesRead(ctx: Ctx, parsed: Parsed): Promise<Output> {
  allowOnly(parsed, ["chat", "since", "until", "timezone", "limit", "cursor"]);
  const chat = await resolveChat(ctx.paths.state, one(parsed, "chat", true));
  const tz = one(parsed, "timezone") ?? "UTC";
  const r = range(one(parsed, "since") ?? "today", one(parsed, "until"), tz, ctx.deps.now());
  const limit = integer(parsed, "limit", 50, 1, 100);
  const cursor = one(parsed, "cursor");
  const page = (await ctx.wacli.call("messages list", [`--chat=${chat}`, ...wacliBounds(r), `--limit=${limit}`, ...(cursor ? [`--cursor=${cursor}`] : [])])) as Page;
  const rows = [...(page.messages ?? [])].reverse();
  const next = page.page?.has_more ? (page.page.next_cursor ?? null) : null;
  const base = ["messages", "read", "--chat", chat, "--since", r.since?.toISOString() ?? "all", "--until", r.until.toISOString(), "--timezone", tz, "--limit", String(limit)];
  const older = next ? continuation(base, next) : null;
  return {
    json: { chat, complete: !page.page?.has_more, messages: rows.map(message), nextCursor: next, since: r.since?.toISOString() ?? null, until: r.until.toISOString() },
    text: `${rows.length} messages in ${chat}${older ? `\nolder: ${older}` : ""}\n${rows.map((m) => line(m, tz)).join("")}`,
  };
}

export async function messagesSearch(ctx: Ctx, parsed: Parsed): Promise<Output> {
  allowOnly(parsed, ["chat", "query", "since", "until", "timezone", "limit", "cursor"]);
  const query = one(parsed, "query", true);
  const ref = one(parsed, "chat");
  const chat = ref ? await resolveChat(ctx.paths.state, ref) : undefined;
  const tz = one(parsed, "timezone") ?? "UTC";
  const r = range(one(parsed, "since") ?? "all", one(parsed, "until"), tz, ctx.deps.now());
  const limit = integer(parsed, "limit", 50, 1, 100);
  const cursor = one(parsed, "cursor");
  // Flags first, then `--`, so a query that starts with "-" stays the query.
  const page = (await ctx.wacli.call("messages search", [
    ...(chat ? [`--chat=${chat}`] : []),
    ...wacliBounds(r),
    `--limit=${limit}`,
    ...(cursor ? [`--cursor=${cursor}`] : []),
    "--",
    query,
  ])) as Page;
  const rows = page.messages ?? [];
  const next = page.page?.has_more ? (page.page.next_cursor ?? null) : null;
  const base = ["messages", "search", "--query", query, ...(chat ? ["--chat", chat] : []), "--since", r.since?.toISOString() ?? "all", "--until", r.until.toISOString(), "--timezone", tz, "--limit", String(limit)];
  return {
    json: { chat: chat ?? null, complete: !page.page?.has_more, messages: rows.map(message), nextCursor: next, query },
    text: `${rows.length} matches${next ? `\nmore: ${continuation(base, next)}` : ""}\n${rows.map((m) => line(m, tz)).join("")}`,
  };
}

/** One attachment to a private file; may fetch from WhatsApp's CDN, never asks the phone and records nothing. */
export async function messagesDownload(ctx: Ctx, parsed: Parsed): Promise<Output> {
  allowOnly(parsed, ["chat", "id", "output"]);
  const chat = await resolveChat(ctx.paths.state, one(parsed, "chat", true));
  const id = messageId(one(parsed, "id", true));
  const requested = one(parsed, "output");
  let output: string;
  if (requested) {
    output = path.resolve(requested);
    if (existsSync(output)) {
      throw new CliError("output_exists", `${output} exists; downloads never overwrite`, { recovery: "Pass a new --output path or omit it" });
    }
    await privateDir(path.dirname(output));
  } else {
    output = await privateDir(path.join(ctx.paths.state, "downloads", randomUUID()));
  }
  const media = (await ctx.wacli.call("media download", [`--chat=${chat}`, `--id=${id}`, `--output=${output}`])) as { path?: string; bytes?: number; media_type?: string; mime_type?: string; source?: string };
  const json = { bytes: media.bytes ?? null, chat, id, mediaType: media.media_type ?? null, mime: media.mime_type ?? null, path: media.path ?? output, source: media.source ?? null };
  return { json, text: `downloaded ${json.path} (${json.bytes ?? "?"} bytes, ${json.mime ?? "unknown type"}); treat it as untrusted\n` };
}
