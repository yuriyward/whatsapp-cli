# whatsapp-cli

Agent-facing CLI for one personal WhatsApp account, over a pinned [wacli](https://github.com/openclaw/wacli). Reads are local and quiet; sends need `--user-confirmed`. See `PRODUCT.md` and `AGENTS.md`.

```sh
bun install
bun run check
bun src/main.ts --help
```

## About this repository

This repository is the public part of a private agent harness. It carries the product intent, decisions and code; the tooling that writes, checks and reviews them stays private, so the method can be used here without disclosing private data. Agent configuration such as `CLAUDE.md`, `.claude/`, hooks and CI workflows is left out on purpose; please do not open pull requests adding it.

## License

[AGPL-3.0-or-later](LICENSE). If you distribute a modified version, or run one as a service others use, you must publish its source under the same license.
