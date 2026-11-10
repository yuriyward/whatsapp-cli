import path from "node:path";
import { allowOnly, one, type Parsed } from "./args.ts";
import { CliError, EXIT, usage } from "./errors.ts";
import { readJson, writeJson } from "./state.ts";

/** Exact JIDs wacli stores: users, LIDs, groups and channels. */
const JID = /^[0-9]{5,20}(?::[0-9]{1,3})?@(s\.whatsapp\.net|lid)$|^[0-9]{10,25}(-[0-9]{9,12})?@g\.us$|^[0-9]{10,25}@newsletter$/;
const E164 = /^\+[1-9][0-9]{6,14}$/;
const ALIAS = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;

type Aliases = Record<string, string>;
const aliasFile = (state: string) => path.join(state, "aliases.json");

/** A JID or E.164 number becomes a JID; never a display name (N3). */
function exact(ref: string): string | undefined {
  if (JID.test(ref)) {
    return ref;
  }
  if (E164.test(ref)) {
    return `${ref.slice(1)}@s.whatsapp.net`;
  }
  return undefined;
}

/** Resolve a chat reference: exact JID, E.164 number or saved alias. */
export async function resolveChat(state: string, ref: string): Promise<string> {
  const jid = exact(ref);
  if (jid) {
    return jid;
  }
  const aliases = await readJson<Aliases>(aliasFile(state), {});
  const target = aliases[ref.normalize("NFC").toLowerCase()];
  if (target) {
    return target;
  }
  throw new CliError("chat_not_found", `${JSON.stringify(ref)} is not a JID, an E.164 number (+15550000001) or a saved alias`, {
    exitCode: EXIT.notFound,
    recovery: `whatsapp-cli chats list --search ${JSON.stringify(ref)}, then use the jid or whatsapp-cli aliases set`,
  });
}

export async function aliasesSet(state: string, parsed: Parsed) {
  allowOnly(parsed, ["name", "chat", "replace"]);
  const name = one(parsed, "name", true).normalize("NFC").toLowerCase();
  if (!ALIAS.test(name) || exact(name)) {
    throw usage("--name must be 1-64 letters, digits, '.', '_' or '-', starting with a letter or digit");
  }
  const ref = one(parsed, "chat", true);
  const jid = exact(ref);
  if (!jid) {
    throw usage("--chat for an alias must be an exact JID or E.164 number", "whatsapp-cli chats list --search <name>");
  }
  const aliases = await readJson<Aliases>(aliasFile(state), {});
  const previous = aliases[name];
  if (previous && previous !== jid && !parsed.bools.has("replace")) {
    throw new CliError("alias_exists", `Alias ${name} already points to ${previous}`, {
      recovery: `whatsapp-cli aliases set --name ${name} --chat ${jid} --replace`,
    });
  }
  aliases[name] = jid;
  await writeJson(aliasFile(state), aliases);
  return { json: { alias: { chat: jid, name } }, text: `alias ${name} -> ${jid}\n` };
}

export async function aliasesList(state: string, parsed: Parsed) {
  allowOnly(parsed, []);
  const aliases = await readJson<Aliases>(aliasFile(state), {});
  const rows = Object.entries(aliases)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, chat]) => ({ chat, name }));
  return { json: { aliases: rows }, text: `${rows.length} aliases\n${rows.map((r) => `${r.name} -> ${r.chat}\n`).join("")}` };
}

/** Aliases by JID, to show beside chats. */
export async function aliasesByChat(state: string) {
  const byChat = new Map<string, string[]>();
  for (const [name, chat] of Object.entries(await readJson<Aliases>(aliasFile(state), {}))) {
    byChat.set(chat, [...(byChat.get(chat) ?? []), name]);
  }
  return byChat;
}
