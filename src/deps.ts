import { statfs } from "node:fs/promises";
import path from "node:path";
import { usage } from "./errors.ts";

export interface Exec {
  exitCode: number;
  stdout: string;
  stderr: string;
}
/** The program never started, so it did nothing; distinct from any failure of a running program. */
export class SpawnError extends Error {
  constructor(program: string, reason: string) {
    super(`${program}: ${reason}`);
  }
}

/** Everything that touches the process environment, injectable for tests. */
export interface Deps {
  env: Record<string, string | undefined>;
  exec: (argv: string[]) => Promise<Exec>;
  now: () => Date;
  freeBytes: (dir: string) => Promise<number>;
  readStdin: () => Promise<string>;
}
export function defaultDeps(env: Record<string, string | undefined>): Deps {
  return {
    env,
    async exec(argv) {
      let child;
      try {
        child = Bun.spawn(argv, { env: env as Record<string, string>, stderr: "pipe", stdin: "ignore", stdout: "pipe" });
      } catch (error) {
        throw new SpawnError(argv[0] ?? "?", error instanceof Error ? error.message : String(error));
      }
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { exitCode, stderr, stdout };
    },
    async freeBytes(dir) {
      const s = await statfs(dir);
      return Number(s.bavail) * Number(s.bsize);
    },
    now: () => new Date(),
    readStdin: () => Bun.stdin.text(),
  };
}

/**
 * `systemctl --user` needs the user manager's runtime dir. Agent jobs can run without XDG_RUNTIME_DIR
 * (an agent sandbox, 2026-11-10), which made every service check read "stopped"; default it to
 * the systemd location for this uid.
 */
export function withUserBus(env: Record<string, string | undefined>, uid = process.getuid?.()) {
  return env.XDG_RUNTIME_DIR || uid === undefined ? env : { ...env, XDG_RUNTIME_DIR: `/run/user/${uid}` };
}

/** The one wacli store and the wrapper's own state; both outside git. */
export interface Paths {
  store: string;
  state: string;
}
export function paths(env: Record<string, string | undefined>): Paths {
  const home = env.HOME;
  const store = env.WHATSAPP_CLI_STORE ?? (home ? path.join(home, ".local/state/wacli") : undefined);
  const stateRoot = env.XDG_STATE_HOME ?? (home ? path.join(home, ".local/state") : undefined);
  const state = env.WHATSAPP_CLI_STATE ?? (stateRoot ? path.join(stateRoot, "whatsapp-cli") : undefined);
  if (!store || !path.isAbsolute(store) || !state || !path.isAbsolute(state)) {
    throw usage("HOME, WHATSAPP_CLI_STORE and WHATSAPP_CLI_STATE must give absolute paths");
  }
  return { state, store: path.resolve(store) };
}
