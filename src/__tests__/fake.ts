import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../main.ts";

/**
 * A fake `wacli` and `systemctl` on PATH. Each records its argv as one JSON line in calls.jsonl and answers
 * from fixtures.json: a map from command words ("messages export", "systemctl start") to responses used in
 * order (the last repeats). `systemctl is-active` follows the `active` marker, which stop/start remove/create.
 * Identities are synthetic (+1555…).
 */
const SCRIPT = `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const dir = process.env.FAKE_DIR;
const name = process.argv[1].split("/").pop();
const args = process.argv.slice(2);
appendFileSync(dir + "/calls.jsonl", JSON.stringify([name, ...args]) + "\\n");
const fixtures = existsSync(dir + "/fixtures.json") ? JSON.parse(readFileSync(dir + "/fixtures.json", "utf8")) : {};
let key;
if (name === "systemctl") {
  const verb = args[1];
  const unit = args[args.length - 1];
  // wacli-sync's state is the "active" marker; any other unit has its own.
  const marker = dir + (unit === "wacli-sync" ? "/active" : "/active-" + unit);
  key = "systemctl " + verb;
  for (const p of fixtures[key]?.remove ?? []) rmSync(p, { force: true });
  // "barrier": N callers wait here for each other (up to 1.5 s), so separate processes race at this point.
  if (fixtures[key]?.barrier) {
    writeFileSync(dir + "/barrier-" + process.pid, "");
    const until = Date.now() + 1500;
    while (Date.now() < until && (await import("node:fs")).readdirSync(dir).filter((n) => n.startsWith("barrier-")).length < fixtures[key].barrier) await Bun.sleep(10);
  }
  if (!(key in fixtures) || fixtures[key].remove || fixtures[key].barrier) {
    if (verb === "is-active") process.exit(existsSync(marker) ? 0 : 3);
    if (verb === "stop") rmSync(marker, { force: true });
    if (verb === "start") writeFileSync(marker, "");
    process.exit(0);
  }
} else if (name === "systemd-run") {
  // Runs the transient unit in-process: ExecStartPre, the command with its output appended to the
  // StandardOutput/StandardError files, then each ExecStopPost; a "-" prefix ignores that line's failure.
  const { spawnSync } = await import("node:child_process");
  const props = args.flatMap((a, i) => (args[i - 1] === "-p" ? [a] : []));
  const prop = (k) => props.filter((p) => p.startsWith(k + "=")).map((p) => p.slice(k.length + 1));
  // Like systemd, every Exec line's output goes to the unit's StandardOutput/StandardError files.
  const file = (k) => prop(k)[0].replace("append:", "");
  const exec = (line) => {
    const ignore = line.startsWith("-");
    const [cmd, ...rest] = (ignore ? line.slice(1) : line).split(" ");
    const r = spawnSync(cmd, rest, { env: process.env });
    appendFileSync(file("StandardOutput"), r.stdout);
    appendFileSync(file("StandardError"), r.stderr);
    return r.status === 0 || ignore;
  };
  const fx = fixtures["systemd-run"] ?? {};
  if (fx.refuse) { process.stderr.write("Failed to start transient service unit\\n"); process.exit(1); }
  let status = 1;
  if (prop("ExecStartPre").every(exec)) {
    const command = args.slice(args.indexOf("--") + 1);
    const r = spawnSync(command[0], command.slice(1), { env: process.env });
    appendFileSync(file("StandardOutput"), r.stdout);
    appendFileSync(file("StandardError"), r.stderr);
    status = r.status;
  }
  for (const line of prop("ExecStopPost")) {
    if (!exec(line)) break;
  }
  // "thenRun": on the first unit only, run another command after the unit ends and before this caller
  // collects its output, e.g. a second wrapper's whole backfill.
  const runs = dir + "/count-systemd-run";
  const n = existsSync(runs) ? Number(readFileSync(runs, "utf8")) : 0;
  writeFileSync(runs, String(n + 1));
  if (fx.thenRun && n === 0) spawnSync(fx.thenRun[0], fx.thenRun.slice(1), { env: process.env });
  process.exit(status);
} else {
  const words = args.filter((a, i) => !a.startsWith("-") && args[i - 1] !== "--store");
  key = words.slice(0, 2).join(" ");
}
const list = [].concat(fixtures[key] ?? [{ data: null }]);
const countFile = dir + "/count-" + key.replaceAll(" ", "_");
const n = existsSync(countFile) ? Number(readFileSync(countFile, "utf8")) : 0;
writeFileSync(countFile, String(n + 1));
const r = list[Math.min(n, list.length - 1)];
if (r.recordEnv) writeFileSync(dir + "/env-" + r.recordEnv, process.env[r.recordEnv] ?? "");
// "sabotage": paths turned into non-empty directories while this command runs, so later appends and deletes fail.
for (const p of r.sabotage ?? []) {
  rmSync(p, { force: true });
  mkdirSync(p + "/blocked", { recursive: true });
}
if (r.error !== undefined) {
  process.stderr.write(JSON.stringify({ success: false, data: null, error: r.error }) + "\\n");
  process.exit(r.exit ?? 1);
}
if (r.stderr !== undefined) process.stderr.write(r.stderr);
if (r.raw !== undefined) { process.stdout.write(r.raw); process.exit(r.exit ?? 0); }
process.stdout.write(JSON.stringify({ success: true, data: r.data, error: null }) + "\\n");
process.exit(r.exit ?? 0);
`;

export interface Fake {
  dir: string;
  store: string;
  state: string;
  env: Record<string, string>;
  fixtures: (f: Record<string, unknown>) => void;
  daemon: (up: boolean) => void;
  calls: () => string[][];
  wacliCalls: () => string[][];
  cli: (...argv: string[]) => ReturnType<typeof run>;
  /** The CLI as its own process (`bun src/main.ts`), for races between processes. */
  spawn: (...argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}
export const allCalls: string[][] = [];

export function fake(options: { free?: number; stdin?: string } = {}): Fake {
  const dir = mkdtempSync(path.join(tmpdir(), "whatsapp-cli-test-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  for (const name of ["wacli", "systemctl", "systemd-run"]) {
    writeFileSync(path.join(bin, name), SCRIPT);
    chmodSync(path.join(bin, name), 0o755);
  }
  const store = path.join(dir, "home/.local/state/wacli");
  mkdirSync(store, { mode: 0o700, recursive: true });
  writeFileSync(path.join(store, "session.db"), "");
  const state = path.join(dir, "home/.local/state/whatsapp-cli");
  const env = { FAKE_DIR: dir, HOME: path.join(dir, "home"), PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` };
  const calls = () => {
    let text = "";
    try {
      text = readFileSync(path.join(dir, "calls.jsonl"), "utf8");
    } catch {}
    return text.trim() ? text.trim().split("\n").map((l) => JSON.parse(l) as string[]) : [];
  };
  const f: Fake = {
    calls,
    cli: async (...argv) => {
      const before = calls().length;
      const result = await run(argv, {
        env,
        freeBytes: async () => options.free ?? 100 * 1024 ** 3,
        now: () => new Date("2026-11-10T12:00:00Z"),
        readStdin: async () => options.stdin ?? "",
      });
      allCalls.push(...calls().slice(before));
      return result;
    },
    spawn: async (...argv) => {
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../main.ts"), ...argv], { env, stderr: "pipe", stdout: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { exitCode, stderr, stdout };
    },
    daemon: (up) => {
      const marker = path.join(dir, "active");
      const sock = path.join(store, ".send.sock");
      if (up) {
        writeFileSync(marker, "");
        writeFileSync(sock, "");
      } else {
        rmSync(marker, { force: true });
        rmSync(sock, { force: true });
      }
    },
    dir,
    env,
    fixtures: (fx) => writeFileSync(path.join(dir, "fixtures.json"), JSON.stringify(fx)),
    state,
    store,
    wacliCalls: () => calls().filter((c) => c[0] === "wacli"),
  };
  return f;
}

/** A synthetic wacli message row. */
export const msg = (id: string, at: string, text: string, extra: Record<string, unknown> = {}) => ({
  ChatJID: "15550000001@s.whatsapp.net",
  ChatName: "Test Person",
  FromMe: false,
  MsgID: id,
  SenderJID: "15550000001@s.whatsapp.net",
  SenderName: "Test Person",
  Text: text,
  Timestamp: at,
  ...extra,
});
export const page = (messages: unknown[], next: string | null = null) => ({ messages, page: { has_more: next !== null, next_cursor: next } });
