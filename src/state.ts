import { appendFile, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { CliError } from "./errors.ts";

/** Private wrapper state: 0700 directories and 0600 files, outside git (N2). */
export async function privateDir(dir: string) {
  await mkdir(dir, { mode: 0o700, recursive: true });
  return dir;
}
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}
/** Replace a state file atomically. */
export async function writeJson(file: string, value: unknown) {
  await privateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}
/** Create a new file; an existing path is never overwritten. */
export async function createFile(file: string, data: string) {
  await privateDir(path.dirname(file));
  let handle;
  try {
    handle = await open(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CliError("output_exists", `${file} exists; outputs never overwrite`, { recovery: "Pass a new --output path or omit it" });
    }
    throw error;
  }
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}
export async function appendLine(file: string, value: unknown) {
  await privateDir(path.dirname(file));
  await appendFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}
