import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { allowOnly, integer, one, type Parsed } from "./args.ts";
import { CliError, EXIT } from "./errors.ts";
import type { Ctx, Output } from "./reads.ts";
import { resolveChat } from "./refs.ts";
import { privateDir } from "./state.ts";
import { SERVICE } from "./wacli.ts";

/** One backfill at a time: systemd refuses a second transient unit with this name while one runs. */
export const BACKFILL_UNIT = "wacli-backfill";

/**
 * Older history for one chat. wacli backfill needs the writable store, which the daemon holds, and has no
 * delegation (ADR-0005). The whole stop -> backfill -> start runs as a transient user unit, so systemd, not
 * this process, restarts wacli-sync after the backfill exits, even if the wrapper is killed meanwhile.
 * `reset-failed` before the start keeps maintenance restarts out of the daemon's start-limit budget.
 * Refused unless the service is running: before the owner's handoff the pairing process owns the store
 * and its initial history must not be interrupted.
 * Probed on a systemd user manager, 2026-11-10: client killed mid-run, sync restarted when the job ended;
 * five starts against StartLimitBurst=3 all succeeded; stop-post output truncates `truncate:` files, so `append:`.
 */
export async function historyBackfill(ctx: Ctx, parsed: Parsed): Promise<Output> {
  allowOnly(parsed, ["chat", "count"]);
  const chat = await resolveChat(ctx.paths.state, one(parsed, "chat", true));
  const count = integer(parsed, "count", 50, 1, 500);
  const { wacli } = ctx;
  wacli.requireStore();
  if (await wacli.unitActive(BACKFILL_UNIT)) {
    throw new CliError("backfill_running", "Another backfill is running", { recovery: `Wait for it: systemctl --user status ${BACKFILL_UNIT}` });
  }
  if (!(await wacli.daemonRunning())) {
    throw new CliError("daemon_not_running", `Backfill runs only while ${SERVICE} is up; it is not, which also covers initial history capture after pairing`, {
      exitCode: EXIT.owner,
      recovery: `whatsapp-cli auth status; if pairing has finished, the owner runs systemctl --user start ${SERVICE}`,
    });
  }
  // Each run owns its output directory and removes only that, so a later backfill never deletes output another
  // wrapper has not collected yet. Directories a killed wrapper left behind are pruned after a day.
  const root = await privateDir(path.join(ctx.paths.state, "backfill"));
  await pruneStale(root, ctx.deps.now().getTime());
  const dir = await privateDir(path.join(root, randomUUID()));
  const file = (name: string) => path.join(dir, name);
  const systemctl = wacli.which("systemctl");
  const command = wacli.argv("history backfill", [`--chat=${chat}`, `--count=${count}`, "--requests=1"]);
  command[0] = wacli.which("wacli");
  const run = await ctx.deps.exec([
    wacli.which("systemd-run"),
    "--user",
    "--wait",
    "--collect",
    "--quiet",
    // The MAIN script's $ words are the shell's, never systemd's.
    "--expand-environment=no",
    `--unit=${BACKFILL_UNIT}`,
    `--description=wacli history backfill (stops and restarts ${SERVICE})`,
    "-p",
    "UMask=0077",
    "-p",
    `ExecStartPre=${systemctl} --user stop ${SERVICE}`,
    "-p",
    `ExecStopPost=-${systemctl} --user reset-failed ${SERVICE}`,
    "-p",
    `ExecStopPost=${systemctl} --user start ${SERVICE}`,
    // The unit's own output files collect the hooks' output; wacli writes to its own files.
    "-p",
    `StandardOutput=append:${file("hooks")}`,
    "-p",
    `StandardError=append:${file("hooks")}`,
    "--",
    ...MAIN,
    dir,
    ...command,
  ]);
  const read = (f: string) => readFile(file(f), "utf8").catch(() => null);
  const [stdout, stderr, status, hooks] = [await read("out"), await read("err"), await read("status"), await read("hooks")];
  await rm(dir, { force: true, recursive: true });
  const back = await wacli.unitActive(SERVICE);
  const restart = back ? "" : `; ${SERVICE} is not running again: systemctl --user status ${SERVICE}`;
  const supervisor = (hooks ?? run.stderr).trim().slice(-300);
  // No status file: wacli never finished. With hook output, the stop before it failed; else the unit did.
  if (status === null) {
    throw hooks?.trim()
      ? new CliError("daemon_stop_failed", `systemctl --user stop ${SERVICE} failed, so the backfill did not run: ${supervisor}${restart}`, {
          recovery: `systemctl --user status ${SERVICE} ${BACKFILL_UNIT}`,
        })
      : new CliError("backfill_unit_failed", `systemd-run ${BACKFILL_UNIT} failed (exit ${run.exitCode}) before the backfill finished: ${supervisor}${restart}`, {
          recovery: `systemctl --user status ${BACKFILL_UNIT} ${SERVICE}`,
        });
  }
  let result: unknown;
  try {
    result = wacli.decode("history backfill", { exitCode: Number(status.trim()), stderr: stderr ?? "", stdout: stdout ?? "" });
  } catch (error) {
    if (error instanceof CliError && restart) {
      throw new CliError(error.code, `${error.message}${restart}`, { exitCode: error.exitCode, recovery: `systemctl --user status ${SERVICE}` });
    }
    throw error;
  }
  const r = (result ?? {}) as { messages_added?: number; responses_seen?: number; requests_sent?: number };
  const json = { chat, daemon: back ? "running" : "stopped", messagesAdded: r.messages_added ?? 0, requestsSent: r.requests_sent ?? 0, responsesSeen: r.responses_seen ?? 0 };
  return {
    json,
    text: `backfill ${chat}: ${json.messagesAdded} older messages added (${json.responsesSeen}/${json.requestsSent} responses); ${back ? `${SERVICE} restarted` : `WARNING ${SERVICE} not running: systemctl --user status ${SERVICE}`}\n`,
  };
}

/**
 * The unit's main process: runs wacli with its output in <dir>/out and <dir>/err and records its exit
 * status in <dir>/status, so its result never mixes with the stop/start hooks' output or exit status.
 */
const MAIN = ["/bin/sh", "-c", 'dir=$1; shift; "$@" >"$dir/out" 2>"$dir/err"; s=$?; echo "$s" >"$dir/status"; exit "$s"', "sh"];

const DAY = 86_400_000;
async function pruneStale(root: string, now: number) {
  for (const name of await readdir(root)) {
    const entry = path.join(root, name);
    const info = await stat(entry).catch(() => null);
    if (info && now - info.mtimeMs > DAY) {
      await rm(entry, { force: true, recursive: true });
    }
  }
}
