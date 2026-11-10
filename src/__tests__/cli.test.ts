import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { withUserBus } from "../deps.ts";
import { known } from "../help.ts";
import { commandNames } from "../main.ts";
import path from "node:path";
import { allCalls, fake, msg, page } from "./fake.ts";

const JID = "15550000001@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const json = (r: { stdout: string }) => JSON.parse(r.stdout);
const err = (r: { stderr: string }) => JSON.parse(r.stderr).error;

describe("reads", () => {
  test("every read passes --read-only and the one absolute --store, and maps wacli fields", async () => {
    const f = fake();
    f.fixtures({
      "auth status": { data: { authenticated: true, linked_jid: "15550000009@s.whatsapp.net" } },
      "chats list": { data: [{ jid: JID, kind: "dm", last_message_ts: "2026-11-09T14:55:00Z", name: "Test Person", unread: true, unread_count: 2 }] },
      "media download": { data: { bytes: 10, media_type: "image", mime_type: "image/jpeg", path: "/x/a.jpg", source: "server" } },
      "messages list": { data: page([msg("MSG2", "2026-11-10T09:00:00Z", "second"), msg("MSG1", "2026-11-10T08:00:00Z", "first")], "CUR1") },
      "messages search": { data: page([msg("MSG1", "2026-11-10T08:00:00Z", "first")]) },
    });
    const runs = [
      await f.cli("auth", "status", "--json"),
      await f.cli("chats", "list", "--search", "Test", "--unread", "--json"),
      await f.cli("messages", "read", "--chat", "+15550000001", "--json"),
      await f.cli("messages", "search", "--query", "-first", "--json"),
      await f.cli("messages", "download", "--chat", JID, "--id", "MSG1", "--json"),
    ];
    for (const r of runs) {
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
    }
    const calls = f.wacliCalls();
    expect(calls).toHaveLength(5);
    for (const c of calls) {
      expect(c.slice(1, 5)).toEqual(["--store", f.store, "--read-only", "--json"]);
    }
    const read = json(runs[2] as { stdout: string });
    expect(read.messages.map((m: { id: string }) => m.id)).toEqual(["MSG1", "MSG2"]);
    expect(read.complete).toBe(false);
    expect(calls[2]).toContain(`--chat=${JID}`);
    expect(calls[2]).toContain("--after=2026-11-09T23:59:59Z");
    expect(calls[2]).toContain("--before=2026-11-10T12:00:00Z");
    expect(calls[3]?.slice(-2)).toEqual(["--", "-first"]);
    expect(json(runs[1] as { stdout: string }).chats[0]).toMatchObject({ jid: JID, unreadCount: 2 });
    expect(calls[4]?.find((a) => a.startsWith("--output="))).toStartWith(`--output=${f.state}/downloads/`);
  });

  test("compact text by default, with the exact command for the older page", async () => {
    const f = fake();
    f.fixtures({ "messages list": { data: page([msg("MSG1", "2026-11-10T08:00:00Z", "hello")], "CUR1") } });
    const r = await f.cli("messages", "read", "--chat", JID, "--timezone", "Europe/Warsaw");
    expect(r.stdout).toContain("2026-11-10 09:00 Test Person (MSG1): hello");
    expect(r.stdout).toContain("--cursor CUR1");
    expect(r.stdout).toContain("--until 2026-11-10T12:00:00.000Z");
  });

  test("display names are never resolved to a chat (N3)", async () => {
    const f = fake();
    const r = await f.cli("messages", "read", "--chat", "Test Person", "--json");
    expect(r.exitCode).toBe(4);
    expect(err(r).code).toBe("chat_not_found");
    expect(err(r).recovery).toContain("chats list --search");
    expect(f.wacliCalls()).toHaveLength(0);
  });

  test("aliases resolve to their exact JID", async () => {
    const f = fake();
    f.fixtures({ "messages list": { data: page([]) } });
    expect((await f.cli("aliases", "set", "--name", "Mom", "--chat", "+15550000001")).exitCode).toBe(0);
    expect(err(await f.cli("aliases", "set", "--name", "mom", "--chat", GROUP, "--json")).code).toBe("alias_exists");
    await f.cli("messages", "read", "--chat", "mom");
    expect(f.wacliCalls()[0]).toContain(`--chat=${JID}`);
  });

  test("a store that is not 0700 is refused before wacli runs", async () => {
    const f = fake();
    chmodSync(f.store, 0o755);
    const r = await f.cli("chats", "list", "--json");
    expect(err(r).code).toBe("store_permissions");
    expect(f.wacliCalls()).toHaveLength(0);
  });

  test("a missing store is not_paired with the owner's next step", async () => {
    const f = fake();
    const r = await f.cli("chats", "list", "--json");
    expect(r.exitCode).toBe(0);
    const g = fake();
    rmSync(g.store, { recursive: true });
    const missing = await g.cli("chats", "list", "--json");
    expect(missing.exitCode).toBe(3);
    expect(err(missing).recovery).toContain("auth pair-command");
    const h = fake();
    rmSync(path.join(h.store, "session.db"));
    expect(err(await h.cli("messages", "send", "--chat", JID, "--text", "x", "--user-confirmed", "--json")).code).toBe("not_paired");
    expect(json(await h.cli("auth", "status", "--json")).authenticated).toBe(false);
    expect(h.wacliCalls().map((c) => c.slice(5).join(" "))).toEqual(["auth status"]);
  });
});

describe("export", () => {
  test("pages to the end, writes a file and a receipt with coverage", async () => {
    const f = fake();
    f.fixtures({
      "messages export": [{ data: page([msg("MSG1", "2026-11-04T08:00:00Z", "a")], "C1") }, { data: page([msg("MSG2", "2026-11-05T08:00:00Z", "b")]) }],
      "messages list": { data: page([msg("MSG0", "2026-10-01T08:00:00Z", "old")]) },
    });
    const r = await f.cli("messages", "export", "--chat", JID, "--since", "7d", "--format", "json", "--json");
    expect(r.exitCode).toBe(0);
    const { receipt } = json(r);
    expect(receipt).toMatchObject({ complete: true, count: 2, coverage: { historyGap: false, oldestLocal: "2026-10-01T08:00:00Z" } });
    expect(receipt.path).toStartWith(`${f.state}/exports/`);
    const file = JSON.parse(readFileSync(receipt.path, "utf8"));
    expect(file.messages.map((m: { id: string }) => m.id)).toEqual(["MSG1", "MSG2"]);
    const exports = f.wacliCalls().filter((c) => c.includes("export"));
    expect(exports[1]).toContain("--cursor=C1");
    expect(r.stdout).not.toContain("\"a\"");
  });

  test("a cursor invalidated on every attempt leaves a partial file marked complete:false", async () => {
    const f = fake();
    f.fixtures({
      "messages export": [
        { data: page([msg("MSG1", "2026-11-04T08:00:00Z", "a")], "C1") },
        { error: "archive changed since cursor; restart the read" },
        { error: "archive changed since cursor; restart the read" },
      ],
      "messages list": { data: page([msg("MSG1", "2026-11-04T08:00:00Z", "a")]) },
    });
    const r = await f.cli("messages", "export", "--chat", JID, "--since", "2026-11-01", "--json");
    const { receipt } = json(r);
    expect(receipt.complete).toBe(false);
    expect(receipt.attempts).toBe(3);
    expect(receipt.coverage.historyGap).toBe(true);
    expect(readFileSync(receipt.path, "utf8")).toContain("INCOMPLETE");
  });

  test("never overwrites an existing output", async () => {
    const f = fake();
    f.fixtures({ "messages export": { data: page([]) }, "messages list": { data: page([]) } });
    const out = path.join(f.dir, "x.md");
    await f.cli("messages", "export", "--chat", JID, "--since", "all", "--output", out);
    const again = await f.cli("messages", "export", "--chat", JID, "--since", "all", "--output", out, "--json");
    expect(err(again).code).toBe("output_exists");
  });
});

describe("send and react (N1)", () => {
  test("without --user-confirmed nothing reaches wacli and the exact command is printed", async () => {
    const f = fake();
    f.daemon(true);
    const r = await f.cli("messages", "send", "--chat", JID, "--text", "it's ok", "--json");
    expect(r.exitCode).toBe(2);
    expect(err(r).code).toBe("confirmation_required");
    expect(err(r).message).toContain("it's ok");
    expect(err(r).recovery).toBe(`whatsapp-cli messages send --chat ${JID} --text 'it'\\''s ok' --user-confirmed`);
    f.fixtures({ "messages show": { data: msg("MSG1", "2026-11-10T08:00:00Z", "hi") } });
    const react = await f.cli("messages", "react", "--chat", JID, "--id", "MSG1", "--emoji", "👍", "--json");
    expect(err(react).code).toBe("confirmation_required");
    expect(err(react).message).toContain(`from ${JID}`);
    // Only the read-only target lookup ran; nothing was sent.
    expect(f.wacliCalls().map((c) => c.slice(3, 7))).toEqual([["--read-only", "--json", "messages", "show"]]);
  });

  test("with no daemon the send is refused and wacli send never runs", async () => {
    const f = fake();
    f.daemon(false);
    const r = await f.cli("messages", "send", "--chat", JID, "--text", "hi", "--user-confirmed", "--json");
    expect(r.exitCode).toBe(3);
    expect(err(r).code).toBe("daemon_not_running");
    expect(err(r).recovery).toContain("systemctl --user start wacli-sync");
    expect(f.wacliCalls()).toHaveLength(0);
  });

  test("an active service without its delegate socket also refuses", async () => {
    const f = fake();
    f.daemon(true);
    rmSync(path.join(f.store, ".send.sock"));
    f.fixtures({ "messages show": { data: msg("MSG1", "2026-11-10T08:00:00Z", "hi") } });
    const r = await f.cli("messages", "react", "--chat", JID, "--id", "MSG1", "--emoji", "👍", "--user-confirmed", "--json");
    expect(err(r).code).toBe("daemon_not_running");
    expect(f.wacliCalls().filter((c) => c.includes("send"))).toHaveLength(0);
  });

  test("an IPC failure after dispatch is outcome_unknown, journalled and not retried", async () => {
    const f = fake();
    f.daemon(true);
    f.fixtures({ "send text": { error: "no reply from the running sync process before the timeout; the text may still have gone through" } });
    const r = await f.cli("messages", "send", "--chat", JID, "--text", "hi", "--user-confirmed", "--json");
    expect(r.exitCode).toBe(1);
    expect(err(r).code).toBe("outcome_unknown");
    expect(err(r).recovery).toContain("Do not resend");
    const sends = f.wacliCalls().filter((c) => c.includes("send"));
    expect(sends).toHaveLength(1);
    expect(sends[0]?.slice(1, 4)).toEqual(["--store", f.store, "--json"]);
    const journal = readFileSync(path.join(f.state, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(journal.map((j) => j.outcome)).toEqual(["dispatching", "outcome_unknown"]);
  });

  test("a confirmed send goes through the daemon with explicit flags and is journalled", async () => {
    const f = fake();
    f.daemon(true);
    f.fixtures({ "send text": { data: { id: "SENT1", sent: true, to: JID } } });
    const r = await f.cli("messages", "send", "--chat", JID, "--text", "-looks like a flag", "--reply-to", "MSG1", "--allow-self", "--user-confirmed", "--json");
    expect(r.exitCode).toBe(0);
    expect(json(r)).toMatchObject({ id: "SENT1", sent: true });
    const send = f.wacliCalls()[0] as string[];
    expect(send.slice(4)).toEqual(["send", "text", "--delegate-only", `--to=${JID}`, "--message=-looks like a flag", "--reply-to=MSG1", "--allow-self"]);
    const journal = readFileSync(path.join(f.state, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(journal.map((j) => j.outcome)).toEqual(["dispatching", "sent"]);
  });

  test("file sends pass --delegate-only too, and a daemon gone after the check fails closed as outcome_unknown", async () => {
    const f = fake();
    f.daemon(true);
    const file = path.join(f.dir, "a.txt");
    writeFileSync(file, "x");
    f.fixtures({ "send file": { error: "--delegate-only: no running sync --follow took the request, nothing was sent: store locked" } });
    const r = await f.cli("messages", "send", "--chat", JID, "--file", file, "--caption", "c", "--user-confirmed", "--json");
    expect(err(r).code).toBe("outcome_unknown");
    const sends = f.wacliCalls().filter((c) => c.includes("send"));
    expect(sends).toHaveLength(1);
    expect(sends[0]?.slice(4)).toEqual(["send", "file", "--delegate-only", `--to=${JID}`, `--file=${file}`, "--caption=c"]);
  });

  test("a known send stays a success with its id when the journal and draft delete fail afterwards", async () => {
    const f = fake({ stdin: "hello" });
    f.daemon(true);
    const id = json(await f.cli("drafts", "create", "--chat", JID, "--text-file", "-", "--json")).draft.id as string;
    const draftFile = path.join(f.state, "drafts", `${id}.json`);
    const journal = path.join(f.state, "journal.jsonl");
    f.fixtures({ "send text": { data: { id: "SENT9", sent: true }, sabotage: [journal, draftFile] } });
    const r = await f.cli("messages", "send", "--draft", id, "--user-confirmed", "--json");
    expect(r.exitCode).toBe(0);
    const out = json(r);
    expect(out).toMatchObject({ id: "SENT9", sent: true });
    expect(out.persistenceWarnings).toHaveLength(2);
    expect(out.persistenceWarnings[0]).toContain("journal not updated");
    expect(out.persistenceWarnings[1]).toContain(`draft ${id} not fully deleted`);
    // With the journal still broken, the next send aborts before dispatch: wacli is not called again.
    const next = await f.cli("messages", "send", "--chat", JID, "--text", "x", "--user-confirmed", "--json");
    expect(next.exitCode).toBe(1);
    expect(err(next).code).not.toBe("outcome_unknown");
    expect(f.wacliCalls().filter((c) => c.includes("send"))).toHaveLength(1);
  });

  test("outcome_unknown survives a failed journal append", async () => {
    const f = fake();
    f.daemon(true);
    const journal = path.join(f.state, "journal.jsonl");
    f.fixtures({ "send text": { error: "connection reset", sabotage: [journal] } });
    const r = await f.cli("messages", "send", "--chat", JID, "--text", "hi", "--user-confirmed", "--json");
    expect(err(r).code).toBe("outcome_unknown");
    expect(err(r).journalWarning).toContain("journal not updated");
    expect(err(r).recovery).toContain("Do not resend");
  });

  test("a draft whose send had an unknown outcome stays marked and is never sent again", async () => {
    const f = fake({ stdin: "hello" });
    f.daemon(true);
    const id = json(await f.cli("drafts", "create", "--chat", JID, "--text-file", "-", "--json")).draft.id as string;
    f.fixtures({ "send text": { error: "no reply from the running sync process before the timeout" } });
    const first = await f.cli("messages", "send", "--draft", id, "--user-confirmed", "--json");
    expect(err(first).code).toBe("outcome_unknown");
    const shown = json(await f.cli("drafts", "show", "--id", id, "--json")).draft;
    expect(shown.dispatched.attempt).toBe(err(first).attempt);
    const again = await f.cli("messages", "send", "--draft", id, "--user-confirmed", "--json");
    expect(err(again).code).toBe("draft_dispatched");
    expect(f.wacliCalls().filter((c) => c.includes("send"))).toHaveLength(1);
  });

  test("two processes sending one draft dispatch it once (atomic claim)", async () => {
    const f = fake({ stdin: "only once" });
    f.daemon(true);
    const id = json(await f.cli("drafts", "create", "--chat", JID, "--text-file", "-", "--json")).draft.id as string;
    // Two processes meet at the daemon check, after any load-and-check of the draft.
    f.fixtures({ "send text": { data: { id: "ONCE", sent: true } }, "systemctl is-active": { barrier: 2 } });
    const results = await Promise.all([1, 2].map(() => f.spawn("messages", "send", "--draft", id, "--user-confirmed", "--json")));
    expect(f.wacliCalls().filter((c) => c.includes("send"))).toHaveLength(1);
    expect(results.filter((r) => r.exitCode === 0)).toHaveLength(1);
    const loser = results.find((r) => r.exitCode !== 0) as { stderr: string };
    expect(["draft_dispatched", "draft_not_found"], loser.stderr).toContain(err(loser).code);
  });

  test("a check that fails before wacli starts releases the draft instead of outcome_unknown", async () => {
    const f = fake({ stdin: "retry me" });
    f.daemon(true);
    const id = json(await f.cli("drafts", "create", "--chat", JID, "--text-file", "-", "--json")).draft.id as string;
    const session = path.join(f.store, "session.db");
    f.fixtures({ "systemctl is-active": { remove: [session] } });
    const first = await f.cli("messages", "send", "--draft", id, "--user-confirmed", "--json");
    expect(err(first).code).toBe("not_paired");
    expect(f.wacliCalls()).toHaveLength(0);
    writeFileSync(session, "");
    f.fixtures({ "send text": { data: { id: "LATER", sent: true } } });
    const again = await f.cli("messages", "send", "--draft", id, "--user-confirmed", "--json");
    expect(again.exitCode).toBe(0);
    expect(json(again).id).toBe("LATER");
    const journal = readFileSync(path.join(f.state, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(journal.map((j) => j.outcome)).toEqual(["dispatching", "sent"]);
  });

  test("wacli that cannot start is known unsent: the draft is released, not outcome_unknown", async () => {
    const f = fake({ stdin: "spawn" });
    f.daemon(true);
    const id = json(await f.cli("drafts", "create", "--chat", JID, "--text-file", "-", "--json")).draft.id as string;
    rmSync(path.join(f.dir, "bin/wacli"));
    const r = await f.cli("messages", "send", "--draft", id, "--user-confirmed", "--json");
    expect(err(r).code).toBe("wacli_not_started");
    expect(json(await f.cli("drafts", "show", "--id", id, "--json")).draft.dispatched).toBeUndefined();
  });

  test("a draft is created locally, sent as stored, then removed", async () => {
    const f = fake({ stdin: "line one\nline two\n" });
    f.daemon(true);
    f.fixtures({ "send text": { data: { id: "SENT2", sent: true } } });
    const created = json(await f.cli("drafts", "create", "--chat", JID, "--text-file", "-", "--json"));
    expect(created.draft.content.text).toBe("line one\nline two");
    expect(f.wacliCalls()).toHaveLength(0);
    const id = created.draft.id as string;
    expect(json(await f.cli("drafts", "list", "--json")).drafts).toHaveLength(1);
    const blocked = await f.cli("messages", "send", "--draft", id, "--json");
    expect(err(blocked).recovery).toBe(`whatsapp-cli messages send --draft ${id} --user-confirmed`);
    expect((await f.cli("messages", "send", "--draft", id, "--user-confirmed")).exitCode).toBe(0);
    expect(f.wacliCalls()[0]).toContain("--message=line one\nline two");
    expect(existsSync(path.join(f.state, "drafts", `${id}.json`))).toBe(false);
  });

  describe("react takes the author from the local archive", () => {
    const reactTo = async (chat: string, target: unknown, ...extra: string[]) => {
      const f = fake();
      f.daemon(true);
      f.fixtures({ "messages show": target === undefined ? { error: "message not found" } : { data: target }, "send react": { data: { id: "R1", sent: true } } });
      const r = await f.cli("messages", "react", "--chat", chat, "--id", "MSG1", "--emoji", "🙌", ...extra, "--user-confirmed", "--json");
      const send = f.wacliCalls().find((c) => c.includes("react"));
      return { f, r, send };
    };

    test("an incoming DM message: --sender is the chat's JID", async () => {
      const { r, send, f } = await reactTo(JID, msg("MSG1", "2026-11-10T08:00:00Z", "hi"));
      expect(r.exitCode).toBe(0);
      expect(send?.slice(4)).toEqual(["send", "react", "--delegate-only", `--to=${JID}`, "--id=MSG1", "--reaction=🙌", `--sender=${JID}`]);
      const lookup = f.wacliCalls()[0] as string[];
      expect(lookup.slice(3)).toEqual(["--read-only", "--json", "messages", "show", `--chat=${JID}`, "--id=MSG1"]);
    });

    test("my own message: no --sender", async () => {
      const { r, send } = await reactTo(JID, msg("MSG1", "2026-11-10T08:00:00Z", "mine", { FromMe: true, SenderJID: "15550000009@s.whatsapp.net" }));
      expect(r.exitCode).toBe(0);
      expect(send?.some((a) => a.startsWith("--sender"))).toBe(false);
    });

    test("a group message: --sender is the participant", async () => {
      const { r, send } = await reactTo(GROUP, msg("MSG1", "2026-11-10T08:00:00Z", "hi", { ChatJID: GROUP, SenderJID: "15550000002@s.whatsapp.net" }));
      expect(r.exitCode).toBe(0);
      expect(send).toContain("--sender=15550000002@s.whatsapp.net");
      expect(send).toContain(`--to=${GROUP}`);
    });

    test("a message not in the archive is refused, naming --sender, with no send", async () => {
      for (const target of [undefined, null]) {
        const { r, f } = await reactTo(JID, target);
        expect(err(r).code).toBe("reaction_target_unknown");
        expect(err(r).recovery).toContain("--sender");
        expect(f.wacliCalls().filter((c) => c.includes("send"))).toHaveLength(0);
      }
    });

    test("an explicit --sender overrides the lookup", async () => {
      const { r, send, f } = await reactTo(GROUP, undefined, "--sender", "15550000003@s.whatsapp.net");
      expect(r.exitCode).toBe(0);
      expect(send).toContain("--sender=15550000003@s.whatsapp.net");
      expect(f.wacliCalls().some((c) => c.includes("show"))).toBe(false);
    });
  });
});

describe("backfill", () => {
  const steps = (calls: string[][]) =>
    calls.map((c) => (c[0] === "wacli" ? "backfill" : c[0] === "systemd-run" ? "systemd-run" : `${c[2]} ${c[c.length - 1]}`));
  const unitArgs = (f: ReturnType<typeof fake>) => f.calls().find((c) => c[0] === "systemd-run") as string[];

  test("runs stop -> backfill -> reset-failed -> start as one transient unit", async () => {
    const f = fake();
    f.daemon(true);
    f.fixtures({ "history backfill": { data: { messages_added: 40, requests_sent: 1, responses_seen: 1 } } });
    const r = await f.cli("history", "backfill", "--chat", JID, "--json");
    expect(r.stderr).toBe("");
    expect(json(r)).toMatchObject({ daemon: "running", messagesAdded: 40 });
    expect(steps(f.calls())).toEqual([
      "is-active wacli-backfill",
      "is-active wacli-sync",
      "systemd-run",
      "stop wacli-sync",
      "backfill",
      "reset-failed wacli-sync",
      "start wacli-sync",
      "is-active wacli-sync",
    ]);
    const unit = unitArgs(f);
    expect(unit).toContain("--unit=wacli-backfill");
    expect(unit).toContain("--wait");
    expect(unit).toContain("UMask=0077");
    expect(unit).toContain(`ExecStopPost=-${path.join(f.dir, "bin/systemctl")} --user reset-failed wacli-sync`);
    const main = unit.slice(unit.indexOf("--") + 1);
    expect(main.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    const command = main.slice(5);
    expect(command.slice(0, 4)).toEqual([path.join(f.dir, "bin/wacli"), "--store", f.store, "--json"]);
    expect(unit).toContain(`StandardOutput=append:${main[4]}/hooks`);
    expect(command).not.toContain("--read-only");
  });

  test("restarts the service once even when the backfill fails, and reports wacli's error", async () => {
    const f = fake();
    f.daemon(true);
    f.fixtures({
      "history backfill": { error: "no response from the phone" },
      "systemctl reset-failed": { exit: 1, raw: "", stderr: "Failed to reset failed state of unit wacli-sync.service: Unit not loaded.\n" },
    });
    const r = await f.cli("history", "backfill", "--chat", JID, "--json");
    expect(r.exitCode).toBe(1);
    expect(err(r).code).toBe("wacli_failed");
    expect(err(r).message).toContain("no response from the phone");
    expect(err(r).wacliExit).toBe(1);
    expect(steps(f.calls()).filter((s) => s.startsWith("start") || s.startsWith("stop"))).toEqual(["stop wacli-sync", "start wacli-sync"]);
  });

  test("a backfill that runs while another collects its output does not delete that output", async () => {
    const f = fake();
    f.daemon(true);
    const second = [process.execPath, path.join(import.meta.dir, "../main.ts"), "history", "backfill", "--chat", JID, "--json"];
    f.fixtures({ "history backfill": { data: { messages_added: 7 } }, "systemd-run": { thenRun: second } });
    const r = await f.cli("history", "backfill", "--chat", JID, "--json");
    expect(r.stderr).toBe("");
    expect(json(r).messagesAdded).toBe(7);
    expect(f.calls().filter((c) => c[0] === "systemd-run")).toHaveLength(2);
    expect(readdirSync(path.join(f.state, "backfill"))).toEqual([]);
  });

  test("only run directories older than a day are pruned", async () => {
    const f = fake();
    f.daemon(true);
    const root = path.join(f.state, "backfill");
    for (const [name, when] of [["old", "2026-11-08T12:00:00Z"], ["recent", "2026-11-10T11:00:00Z"]] as const) {
      mkdirSync(path.join(root, name), { recursive: true });
      utimesSync(path.join(root, name), new Date(when), new Date(when));
    }
    f.fixtures({ "history backfill": { data: { messages_added: 1 } } });
    expect((await f.cli("history", "backfill", "--chat", JID)).exitCode).toBe(0);
    expect(readdirSync(root)).toEqual(["recent"]);
  });

  test("a failed stop hook is daemon_stop_failed, not a wacli failure", async () => {
    const f = fake();
    f.daemon(true);
    f.fixtures({ "systemctl stop": { exit: 1, raw: "", stderr: "Failed to stop wacli-sync.service: Access denied\n" } });
    const r = await f.cli("history", "backfill", "--chat", JID, "--json");
    expect(f.wacliCalls()).toHaveLength(0);
    expect(err(r).code).toBe("daemon_stop_failed");
    expect(err(r).message).toContain("Access denied");
    expect(err(r).recovery).toContain("systemctl --user status wacli-sync");
  });

  test("a second backfill is refused while one runs, without touching the service", async () => {
    const f = fake();
    f.daemon(true);
    writeFileSync(path.join(f.dir, "active-wacli-backfill"), "");
    const r = await f.cli("history", "backfill", "--chat", JID, "--json");
    expect(err(r).code).toBe("backfill_running");
    expect(steps(f.calls())).toEqual(["is-active wacli-backfill"]);
  });

  test("refuses while the service is down (initial history capture) without starting a unit", async () => {
    const f = fake();
    f.daemon(false);
    const r = await f.cli("history", "backfill", "--chat", JID, "--json");
    expect(err(r).code).toBe("daemon_not_running");
    expect(f.calls().some((c) => c[0] === "systemd-run" || c[2] === "stop")).toBe(false);
  });

  test("a unit that cannot start, or a service that does not come back, is reported with the status command", async () => {
    const f = fake();
    f.daemon(true);
    f.fixtures({ "systemd-run": { refuse: true } });
    expect(err(await f.cli("history", "backfill", "--chat", JID, "--json")).code).toBe("backfill_unit_failed");
    const g = fake();
    g.daemon(true);
    g.fixtures({ "history backfill": { data: { messages_added: 1 } }, "systemctl start": { exit: 1, raw: "" } });
    const r = await g.cli("history", "backfill", "--chat", JID);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("WARNING wacli-sync not running");
  });
});

describe("pairing preconditions", () => {
  test("refuses with less than 5 GB free and prints the command otherwise", async () => {
    const low = fake({ free: 4 * 1024 ** 3 });
    low.fixtures({ "auth status": { data: { authenticated: false } } });
    expect(err(await low.cli("auth", "pair-command", "--json")).code).toBe("disk_low");
    const ok = fake();
    ok.fixtures({ "auth status": { data: { authenticated: false } } });
    const lowErr = err(await low.cli("auth", "pair-command", "--json"));
    expect(lowErr.message).toContain("not a guarantee");
    const r = json(await ok.cli("auth", "pair-command", "--json"));
    expect(r.command).toContain(`wacli --store ${ok.store} auth --follow --full-history 2>`);
    // wacli's documented defaults (0 = no limit / the phone decides): no caps are requested.
    expect(r.command).not.toMatch(/--history-(days|size-mb|max-per-chat)/);
    expect(r.capture).toContain("ongoing");
    expect(r.steps.join("\n")).toContain("not completion");
    expect(ok.wacliCalls().every((c) => c.includes("status"))).toBe(true);
  });
});

describe("environment", () => {
  test("systemctl --user gets the user runtime dir when the job has none", async () => {
    expect(withUserBus({ HOME: "/h" }, 1000).XDG_RUNTIME_DIR).toBe("/run/user/1000");
    expect(withUserBus({ XDG_RUNTIME_DIR: "/run/user/7" }, 1000).XDG_RUNTIME_DIR).toBe("/run/user/7");
    const f = fake();
    f.fixtures({ "systemctl is-active": { raw: "", exit: 0, recordEnv: "XDG_RUNTIME_DIR" } });
    await f.cli("auth", "status");
    expect(readFileSync(path.join(f.dir, "env-XDG_RUNTIME_DIR"), "utf8")).toBe(`/run/user/${process.getuid?.()}`);
  });
});

describe("usage", () => {
  test("every command has its own help", () => {
    expect(commandNames().filter((c) => !known(c))).toEqual([]);
  });

  test("unknown commands and flags name the fix", async () => {
    const f = fake();
    expect(err(await f.cli("messages", "mark-read", "--json")).recovery).toBe("whatsapp-cli --help");
    const bad = await f.cli("chats", "list", "--receipts", "x", "--json");
    expect(bad.exitCode).toBe(2);
    expect(err(bad).recovery).toBe("whatsapp-cli chats list --help");
  });
});

afterAll(() => {
  // ADR-0002 and N4 across every invocation in this file: only allowlisted commands, never read receipts,
  // presence or typing, and always the same flag layout.
  const allowed = new Set(["auth status", "chats list", "history backfill", "media download", "messages export", "messages list", "messages search", "messages show", "send file", "send react", "send text"]);
  expect(allCalls.length).toBeGreaterThan(20);
  for (const c of allCalls.filter((x) => x[0] === "wacli")) {
    expect(c[1]).toBe("--store");
    expect(path.isAbsolute(c[2] as string)).toBe(true);
    const words = c.slice(3).filter((a) => !a.startsWith("--"));
    expect(allowed.has(words.slice(0, 2).join(" "))).toBe(true);
    expect(c.some((a) => /^--(receipts|presence-mode|through-message-id)/.test(a) || a === "mark-read" || a === "presence" || a === "typing")).toBe(false);
    if (words[0] === "send") {
      expect(c[c.indexOf("send") + 2]).toBe("--delegate-only");
    }
  }
});
