import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { type Deps, type Exec, SpawnError } from "./deps.ts";
import { CliError, daemonNotRunning, notPaired } from "./errors.ts";

/**
 * Every wacli command this wrapper may run, by class. Anything else is never invoked (ADR-0002):
 * reads go through `--read-only` and take no store lock; sends are delegated to the running
 * `wacli-sync` daemon; backfill needs the writable store and so stops the daemon first.
 */
const ALLOWED = {
  "auth status": "read",
  "chats list": "read",
  "history backfill": "backfill",
  "media download": "read",
  "messages export": "read",
  "messages list": "read",
  "messages search": "read",
  "messages show": "read",
  "send file": "send",
  "send react": "send",
  "send text": "send",
} as const;
export type WacliCommand = keyof typeof ALLOWED;
/** Flags that would make a read visible to others; the builders never pass them and this refuses them anyway (N4). */
const FORBIDDEN = /^--(receipts|presence-mode|through-message-id)(=|$)/;
export const SERVICE = "wacli-sync";

export class WacliError extends CliError {
  constructor(command: string, message: string, exitCode: number) {
    super("wacli_failed", `wacli ${command} failed: ${message}`, { details: { wacliExit: exitCode } });
  }
}

export class Wacli {
  constructor(
    readonly deps: Deps,
    readonly store: string,
  ) {}

  argv(command: WacliCommand, args: string[]) {
    const kind = ALLOWED[command];
    if (!kind) {
      throw new CliError("internal", `wacli ${command} is not on the allowlist`);
    }
    const bad = args.find((a) => FORBIDDEN.test(a));
    if (bad) {
      throw new CliError("internal", `${bad} is never passed to wacli`);
    }
    return ["wacli", "--store", this.store, ...(kind === "read" ? ["--read-only"] : []), "--json", ...command.split(" "), ...args];
  }

  /** Run one allowlisted command and return its `data`; any failure is a WacliError carrying wacli's own message. */
  async call(command: WacliCommand, args: string[]): Promise<unknown> {
    return this.run(command, this.prepare(command, args));
  }

  /** Every check before wacli runs; a failure here means wacli never started. */
  prepare(command: WacliCommand, args: string[]) {
    this.requireStore(command !== "auth status");
    return this.argv(command, args);
  }

  /** Spawn and decode. A spawn failure is `wacli_not_started` (nothing ran); anything later is wacli's outcome. */
  async run(command: WacliCommand, argv: string[]): Promise<unknown> {
    let result: Exec;
    try {
      result = await this.deps.exec(argv);
    } catch (error) {
      if (error instanceof SpawnError) {
        throw new CliError("wacli_not_started", `wacli could not start: ${error.message}`, { details: { started: false } });
      }
      throw error;
    }
    return this.decode(command, result);
  }

  /** wacli's JSON envelope from a finished run (direct, or under a transient unit). */
  decode(command: WacliCommand, result: Exec): unknown {
    const envelope = parseEnvelope(result.stdout) ?? parseEnvelope(result.stderr);
    if (result.exitCode === 0 && envelope?.success === true) {
      return envelope.data;
    }
    const message = typeof envelope?.error === "string" ? envelope.error : result.stderr.trim().split("\n").at(-1) || `exit ${result.exitCode}`;
    throw new WacliError(command, message.slice(0, 400), result.exitCode);
  }

  /** Absolute path of a program on PATH, for systemd Exec lines that do not search the caller's PATH. */
  which(name: string) {
    const found = Bun.which(name, { PATH: this.deps.env.PATH ?? "" });
    if (!found) {
      throw new CliError("internal", `${name} is not on PATH`);
    }
    return found;
  }

  async unitActive(unit: string) {
    return (await this.deps.exec(["systemctl", "--user", "is-active", "--quiet", unit])).exitCode === 0;
  }

  /** The store exists and is private (0700); a session never lives anywhere else. */
  requireStore(paired = true) {
    if (!existsSync(this.store)) {
      throw notPaired(this.store);
    }
    const mode = statSync(this.store).mode & 0o777;
    if (mode !== 0o700) {
      throw new CliError("store_permissions", `${this.store} has mode ${mode.toString(8)}; the session store must be 0700`, {
        recovery: `chmod 700 ${this.store}`,
      });
    }
    if (paired && !existsSync(path.join(this.store, "session.db"))) {
      throw notPaired(this.store);
    }
  }

  /** The daemon is up and its delegate socket exists, so wacli hands a send to it instead of connecting itself. */
  async daemonRunning() {
    return (await this.unitActive(SERVICE)) && existsSync(path.join(this.store, ".send.sock"));
  }

  async requireDaemon(what: string) {
    if (!(await this.daemonRunning())) {
      throw daemonNotRunning(what);
    }
  }
}

/** The last line that is a wacli envelope; systemctl lines may follow it when wacli ran under a unit. */
function parseEnvelope(text: string): { success?: unknown; data?: unknown; error?: unknown } | undefined {
  for (const line of text.trim().split("\n").reverse()) {
    if (!line.startsWith("{")) {
      continue;
    }
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && "success" in value) {
        return value;
      }
    } catch {}
  }
  return undefined;
}
