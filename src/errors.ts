/** One stable code per failure; `recovery` is the exact next command when one exists. */
export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly recovery: string | undefined;
  readonly details: Record<string, unknown> | undefined;
  constructor(
    code: string,
    message: string,
    options: { exitCode?: number; recovery?: string; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.code = code;
    this.exitCode = options.exitCode ?? EXIT.failed;
    this.recovery = options.recovery;
    this.details = options.details;
  }
}

/** Exit classes; a code keeps its class whatever the output mode. */
export const EXIT = { failed: 1, usage: 2, owner: 3, notFound: 4 } as const;

export const usage = (message: string, recovery = "whatsapp-cli --help") =>
  new CliError("usage", message, { exitCode: EXIT.usage, recovery });

const PAIRING = "Ask the owner to pair: whatsapp-cli auth pair-command prints the exact command for their own terminal";

/** Errors that need the owner or the service, with the command that fixes each. */
export const notPaired = (store: string) =>
  new CliError("not_paired", `No paired WhatsApp session in ${store}`, { exitCode: EXIT.owner, recovery: PAIRING });

export const daemonNotRunning = (what: string) =>
  new CliError("daemon_not_running", `${what} needs the wacli-sync service running; it is not, so nothing was sent or changed`, {
    exitCode: EXIT.owner,
    recovery: "systemctl --user start wacli-sync && whatsapp-cli auth status",
  });
