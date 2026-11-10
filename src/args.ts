import { usage } from "./errors.ts";

const BOOLEAN = new Set(["unread", "json", "user-confirmed", "help", "replace", "allow-self"]);
export interface Parsed {
  words: string[];
  flags: Map<string, string>;
  bools: Set<string>;
}
/** `--name value` pairs and known booleans; positional words only before the first flag. */
export function parseArgs(argv: string[]): Parsed {
  const words: string[] = [];
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "-h") {
      bools.add("help");
      continue;
    }
    if (!arg.startsWith("--")) {
      if (flags.size || [...bools].some((b) => b !== "json")) {
        throw usage(`Unexpected argument ${JSON.stringify(arg)}; pass values after a flag`);
      }
      words.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN.has(name)) {
      bools.add(name);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || (value.startsWith("--") && value !== "-")) {
      throw usage(`--${name} needs a value`);
    }
    i += 1;
    if (flags.has(name)) {
      throw usage(`--${name} given twice`);
    }
    flags.set(name, value);
  }
  return { bools, flags, words };
}
export function one(parsed: Parsed, name: string, required: true): string;
export function one(parsed: Parsed, name: string, required?: false): string | undefined;
export function one(parsed: Parsed, name: string, required = false) {
  const value = parsed.flags.get(name);
  if (required && (value === undefined || value === "")) {
    throw usage(`--${name} is required`, `whatsapp-cli ${parsed.words.join(" ")} --help`);
  }
  return value;
}
/** Refuse any flag the command does not declare, naming the help that lists them. */
export function allowOnly(parsed: Parsed, names: string[]) {
  for (const name of [...parsed.flags.keys(), ...parsed.bools]) {
    if (!["json", "help", ...names].includes(name)) {
      throw usage(`Unknown option --${name} for ${parsed.words.join(" ")}`, `whatsapp-cli ${parsed.words.join(" ")} --help`);
    }
  }
}
export function integer(parsed: Parsed, name: string, fallback: number, min: number, max: number) {
  const raw = one(parsed, name);
  if (raw === undefined) {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw usage(`--${name} must be an integer from ${min} to ${max}`);
  }
  return n;
}
/** wacli message ids are opaque protocol ids: letters, digits and a few separators. */
export function messageId(value: string) {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) {
    throw usage(`${JSON.stringify(value)} is not a message id; take ids from messages read or search`);
  }
  return value;
}
/** Quote one argument for a POSIX shell so a printed command can be pasted back unchanged. */
export const shellQuote = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);
