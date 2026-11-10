import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { link, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { allowOnly, messageId, one, type Parsed } from "./args.ts";
import { CliError, EXIT, usage } from "./errors.ts";
import type { Ctx, Output } from "./reads.ts";
import { resolveChat } from "./refs.ts";
import { privateDir, readJson, writeJson } from "./state.ts";

/** What a send or a draft carries: text, or one file with an optional caption. */
export type Content = { kind: "text"; text: string } | { kind: "file"; file: string; caption: string | null };
export interface Draft {
  id: string;
  chat: string;
  createdAt: string;
  content: Content;
  replyTo: string | null;
  /** From the claim file: the attempt that is sending it or sent it with an unknown outcome. */
  dispatched?: { attempt: string; at: string };
}
const MAX_TEXT = 65_536;
export const CONTENT_FLAGS = ["text", "text-file", "file", "caption"];

export async function content(ctx: Ctx, parsed: Parsed): Promise<Content> {
  const given = ["text", "text-file", "file"].filter((f) => parsed.flags.has(f));
  if (given.length !== 1) {
    throw usage("Pass exactly one of --text, --text-file <path|-> or --file <path>");
  }
  if (parsed.flags.has("caption") && !parsed.flags.has("file")) {
    throw usage("--caption goes with --file");
  }
  const file = one(parsed, "file");
  if (file) {
    const abs = path.resolve(file);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw new CliError("file_not_found", `${abs} is not a readable file`, { exitCode: EXIT.notFound });
    }
    return { caption: one(parsed, "caption") ?? null, file: abs, kind: "file" };
  }
  const source = one(parsed, "text-file");
  const text = source === undefined ? (one(parsed, "text") as string) : source === "-" ? await ctx.deps.readStdin() : await readFile(source, "utf8");
  const trimmed = text.replace(/^\s*\n|\s+$/g, "");
  if (!trimmed || trimmed.length > MAX_TEXT) {
    throw usage(`Message text must be 1-${MAX_TEXT} characters after trimming`);
  }
  return { kind: "text", text: trimmed };
}

const dir = (ctx: Ctx) => path.join(ctx.paths.state, "drafts");
const DRAFT_ID = /^d-[0-9a-f]{8}$/;
export async function loadDraft(ctx: Ctx, id: string): Promise<Draft> {
  if (!DRAFT_ID.test(id)) {
    throw usage("--draft/--id must be a draft id like d-1a2b3c4d from drafts list");
  }
  const draft = await readJson<Draft | null>(path.join(dir(ctx), `${id}.json`), null);
  if (!draft) {
    throw new CliError("draft_not_found", `Draft ${id} does not exist`, { exitCode: EXIT.notFound, recovery: "whatsapp-cli drafts list" });
  }
  const claim = await readJson<Draft["dispatched"] | null>(claimFile(ctx, id), null);
  return claim ? { ...draft, dispatched: claim } : draft;
}
/**
 * A claim file, created exclusively, marks a draft as being sent or sent with an unknown outcome. Exactly
 * one process can create it, so a draft is dispatched at most once; it is released only when the send is
 * known not to have happened.
 */
const claimFile = (ctx: Ctx, id: string) => path.join(dir(ctx), `${id}.claim`);
export async function claimDraft(ctx: Ctx, id: string, attempt: string, at: string) {
  if (!DRAFT_ID.test(id)) {
    throw usage("--draft/--id must be a draft id like d-1a2b3c4d from drafts list");
  }
  await privateDir(dir(ctx));
  // Written whole to a private temp file, then hard-linked: link fails with EEXIST atomically, and a reader
  // never sees a half-written claim (an open("wx") claim was read empty by the losing process).
  const tmp = `${claimFile(ctx, id)}.${attempt}.tmp`;
  await writeFile(tmp, JSON.stringify({ at, attempt }), { mode: 0o600 });
  try {
    await link(tmp, claimFile(ctx, id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    throw dispatchedError(id, await readJson<Draft["dispatched"] | null>(claimFile(ctx, id), null));
  } finally {
    await rm(tmp, { force: true });
  }
  return () => rm(claimFile(ctx, id), { force: true });
}
export function dispatchedError(id: string, claim: Draft["dispatched"] | null) {
  return new CliError("draft_dispatched", `Draft ${id} was already dispatched (attempt ${claim?.attempt ?? "?"}, ${claim?.at ?? "?"}); it is never sent twice`, {
    recovery: `Check whatsapp-cli messages read --since today for its chat; if it truly did not arrive: whatsapp-cli drafts delete --id ${id}, then create a new draft`,
  });
}
/** Removes the draft first, then its claim, so a leftover claim never frees a draft that was sent. */
export async function deleteDraft(ctx: Ctx, id: string) {
  await rm(path.join(dir(ctx), `${id}.json`), { force: true });
  await rm(claimFile(ctx, id), { force: true });
}

export function preview(chat: string, c: Content, replyTo: string | null) {
  const body = c.kind === "text" ? c.text : `file ${c.file}${c.caption ? ` caption ${JSON.stringify(c.caption)}` : ""}`;
  return `to ${chat}${replyTo ? ` replying to ${replyTo}` : ""}:\n${body}\n`;
}

export async function draftsCreate(ctx: Ctx, parsed: Parsed): Promise<Output> {
  allowOnly(parsed, ["chat", "reply-to", ...CONTENT_FLAGS]);
  const chat = await resolveChat(ctx.paths.state, one(parsed, "chat", true));
  const reply = one(parsed, "reply-to");
  const draft: Draft = {
    chat,
    content: await content(ctx, parsed),
    createdAt: ctx.deps.now().toISOString(),
    id: `d-${randomBytes(4).toString("hex")}`,
    replyTo: reply ? messageId(reply) : null,
  };
  await writeJson(path.join(dir(ctx), `${draft.id}.json`), draft);
  return { json: { draft }, text: `draft ${draft.id} (local only; nothing sent)\n${preview(chat, draft.content, draft.replyTo)}` };
}

export async function draftsList(ctx: Ctx, parsed: Parsed): Promise<Output> {
  allowOnly(parsed, []);
  const names = existsSync(dir(ctx)) ? (await readdir(dir(ctx))).filter((n) => DRAFT_ID.test(n.replace(/\.json$/, ""))) : [];
  const drafts = (await Promise.all(names.map((n) => loadDraft(ctx, n.replace(/\.json$/, ""))))).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const head = (d: Draft) => (d.content.kind === "text" ? d.content.text.split("\n")[0]?.slice(0, 80) : `file ${path.basename(d.content.file)}`);
  return { json: { drafts }, text: `${drafts.length} drafts\n${drafts.map((d) => `${d.id} ${d.chat} ${d.createdAt} ${JSON.stringify(head(d))}\n`).join("")}` };
}

export async function draftsShow(ctx: Ctx, parsed: Parsed): Promise<Output> {
  allowOnly(parsed, ["id"]);
  const draft = await loadDraft(ctx, one(parsed, "id", true));
  return { json: { draft }, text: `draft ${draft.id}\n${preview(draft.chat, draft.content, draft.replyTo)}` };
}

export async function draftsDelete(ctx: Ctx, parsed: Parsed): Promise<Output> {
  allowOnly(parsed, ["id"]);
  const draft = await loadDraft(ctx, one(parsed, "id", true));
  await deleteDraft(ctx, draft.id);
  return { json: { deleted: draft.id }, text: `deleted draft ${draft.id}\n` };
}
