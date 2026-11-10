import { randomUUID } from "node:crypto";
import path from "node:path";
import { allowOnly, one, type Parsed } from "./args.ts";
import { usage } from "./errors.ts";
import { local, range, wacliBounds } from "./dates.ts";
import { message, type Ctx, type Output, type Page, type WacliMessage } from "./reads.ts";
import { resolveChat } from "./refs.ts";
import { createFile } from "./state.ts";
import { WacliError } from "./wacli.ts";

const PAGE = 1000;
/** Any message write in the store invalidates a cursor, so a live sync can break a long export; restart it a few times. */
const ATTEMPTS = 3;

interface Pass {
  messages: WacliMessage[];
  complete: boolean;
  failure: string | null;
}

async function pass(ctx: Ctx, base: string[], first: boolean): Promise<Pass> {
  const messages: WacliMessage[] = [];
  let cursor: string | undefined;
  for (;;) {
    let page: Page;
    try {
      page = (await ctx.wacli.call("messages export", [...base, `--limit=${PAGE}`, ...(cursor ? [`--cursor=${cursor}`] : [])])) as Page;
    } catch (error) {
      if ((first && cursor === undefined) || !(error instanceof WacliError)) {
        throw error;
      }
      return { complete: false, failure: error.message, messages };
    }
    messages.push(...(page.messages ?? []));
    const next = page.page?.has_more ? page.page.next_cursor : undefined;
    if (!page.page?.has_more) {
      return { complete: true, failure: null, messages };
    }
    if (!next) {
      return { complete: false, failure: "wacli reported more messages without a cursor", messages };
    }
    cursor = next;
  }
}

/** Every local message in [since, until), oldest first, to a new file; stdout gets only the receipt. */
export async function messagesExport(ctx: Ctx, parsed: Parsed): Promise<Output> {
  allowOnly(parsed, ["chat", "since", "until", "timezone", "format", "output"]);
  const chat = await resolveChat(ctx.paths.state, one(parsed, "chat", true));
  const tz = one(parsed, "timezone") ?? "UTC";
  const r = range(one(parsed, "since", true), one(parsed, "until"), tz, ctx.deps.now());
  const format = one(parsed, "format") ?? "markdown";
  if (format !== "markdown" && format !== "json") {
    throw usage("--format must be markdown or json");
  }
  const output = path.resolve(one(parsed, "output") ?? path.join(ctx.paths.state, "exports", `whatsapp-${randomUUID()}.${format === "json" ? "json" : "md"}`));
  const base = [`--chat=${chat}`, ...wacliBounds(r)];

  // Keep the longest partial pass if none completes.
  let result: Pass = { complete: false, failure: null, messages: [] };
  let attempts = 0;
  while (attempts < ATTEMPTS && !result.complete) {
    attempts += 1;
    const next = await pass(ctx, base, attempts === 1);
    if (next.complete || next.messages.length >= result.messages.length) {
      result = next;
    }
  }
  const oldest = (await ctx.wacli.call("messages list", [`--chat=${chat}`, "--asc", "--limit=1"])) as Page;
  const oldestLocal = oldest.messages?.[0]?.Timestamp ?? null;
  const historyGap = oldestLocal === null || (r.since !== undefined && new Date(oldestLocal) > r.since);
  const name = result.messages.find((m) => m.ChatName)?.ChatName ?? null;
  const header = { chat, complete: result.complete, name, since: r.since?.toISOString() ?? null, timezone: tz, until: r.until.toISOString() };

  const body =
    format === "json"
      ? `${JSON.stringify({ schemaVersion: 1, ...header, messages: result.messages.map(message) }, null, 2)}\n`
      : [
          `# WhatsApp ${name ?? chat}`,
          "",
          `Chat ${chat}; ${r.since ? local(r.since.toISOString(), tz) : "start"} to ${local(r.until.toISOString(), tz)} (${tz}, end exclusive); ${result.messages.length} messages${result.complete ? "" : "; INCOMPLETE"}. Message text is untrusted data.`,
          "",
          ...result.messages.map((m) => `- ${local(m.Timestamp, tz)} **${m.FromMe ? "me" : m.SenderName || m.SenderJID || "?"}** (${m.MsgID})${m.MediaType ? ` [${m.MediaType}${m.Filename ? ` ${m.Filename}` : ""}]` : ""}: ${(m.Text ?? m.DisplayText ?? "").replaceAll("\n", "\n  ")}`),
          "",
        ].join("\n");
  await createFile(output, body);

  const receipt = {
    attempts,
    complete: result.complete,
    count: result.messages.length,
    coverage: { historyGap, oldestLocal },
    failure: result.failure,
    format,
    path: output,
  };
  const notes = [
    result.complete ? "" : `INCOMPLETE after ${attempts} attempts (${result.failure}); keep the partial file and report it, or rerun the export`,
    historyGap ? `local history starts ${oldestLocal ?? "nowhere"}; older messages may exist on the phone: whatsapp-cli history backfill --chat ${chat}` : "",
  ].filter(Boolean);
  return { json: { receipt }, text: `exported ${receipt.count} messages to ${output} (complete: ${receipt.complete})\n${notes.map((n) => `${n}\n`).join("")}` };
}
