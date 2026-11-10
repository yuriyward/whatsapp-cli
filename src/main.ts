#!/usr/bin/env bun
import { parseArgs } from "./args.ts";
import { historyBackfill } from "./backfill.ts";
import { defaultDeps, type Deps, paths, withUserBus } from "./deps.ts";
import { draftsCreate, draftsDelete, draftsList, draftsShow } from "./drafts.ts";
import { CliError, usage } from "./errors.ts";
import { messagesExport } from "./export.ts";
import { help } from "./help.ts";
import { authPairCommand, authStatus, chatsList, type Ctx, messagesDownload, messagesRead, messagesSearch, type Output } from "./reads.ts";
import { aliasesList, aliasesSet } from "./refs.ts";
import { messagesReact, messagesSend } from "./send.ts";
import { Wacli } from "./wacli.ts";

export const SCHEMA_VERSION = 1;
export const commandNames = () => Object.keys(COMMANDS);
export interface Result {
  exitCode: number;
  stdout: string;
  stderr: string;
}
type Command = (ctx: Ctx, parsed: ReturnType<typeof parseArgs>, argv: string[]) => Promise<Output>;
const COMMANDS: Record<string, Command> = {
  "aliases list": (c, p) => aliasesList(c.paths.state, p),
  "aliases set": (c, p) => aliasesSet(c.paths.state, p),
  "auth pair-command": authPairCommand,
  "auth status": authStatus,
  "chats list": chatsList,
  "drafts create": draftsCreate,
  "drafts delete": draftsDelete,
  "drafts list": draftsList,
  "drafts show": draftsShow,
  "history backfill": historyBackfill,
  "messages download": messagesDownload,
  "messages export": messagesExport,
  "messages react": messagesReact,
  "messages read": messagesRead,
  "messages search": messagesSearch,
  "messages send": messagesSend,
};

async function dispatch(argv: string[], deps: Deps): Promise<Output> {
  const parsed = parseArgs(argv);
  const key = parsed.words.join(" ");
  if (parsed.bools.has("help") || !parsed.words.length) {
    return { json: { help: help(key) }, text: `${help(key)}\n` };
  }
  const command = COMMANDS[key];
  if (!command) {
    throw usage(`Unknown command ${JSON.stringify(key)}`, "whatsapp-cli --help");
  }
  const p = paths(deps.env);
  return command({ deps, paths: p, wacli: new Wacli(deps, p.store) }, parsed, argv);
}

export async function run(argv: string[], overrides: Partial<Deps> = {}): Promise<Result> {
  const env = withUserBus(overrides.env ?? process.env);
  const deps = { ...defaultDeps(env), ...overrides, env };
  const json = argv.includes("--json");
  try {
    const out = await dispatch(argv, deps);
    return { exitCode: 0, stderr: "", stdout: json ? `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...out.json })}\n` : out.text };
  } catch (error) {
    const e = error instanceof CliError ? error : new CliError("internal", error instanceof Error ? error.message.slice(0, 300) : "failed");
    const stderr = json
      ? `${JSON.stringify({ error: { code: e.code, message: e.message, recovery: e.recovery ?? null, ...e.details }, schemaVersion: SCHEMA_VERSION })}\n`
      : `error ${e.code}: ${e.message}${e.recovery ? `\ntry: ${e.recovery}` : ""}\n`;
    return { exitCode: e.exitCode, stderr, stdout: "" };
  }
}

if (import.meta.main) {
  const result = await run(Bun.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
