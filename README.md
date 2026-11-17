# dsh-codebase-memory-cli

A DSH plugin for the local **codebase-memory CLI** — a command-line program, not
an MCP server. It spawns the binary, parses its JSON, and gives the agent a
small curated slice of it.

Two properties shape the whole design.

## 1. The index is always current

Every graph read re-indexes first. The CLI's `index` call is incremental — it
decides for itself what to re-extract — so it *is* the correctness boundary: an
answer can never come from a graph older than the call that produced it. There
is no freshness heuristic to get wrong, no change set to assemble, and no
special case for a deleted-but-never-committed file.

The cost is real and measured here, on a 9.5k-node / 39k-edge repository:

| Situation | `index` duration |
|---|---|
| Clean tree, nothing edited | ~3.3 s |
| One file edited | ~4.1 s |
| `--mode fast` on the same tree | ~4.3 s |

The scan does not get cheaper when nothing changed, and `fast` is not cheaper
than `full` — so this trades ~3.5 s per read for never being wrong.
`refreshBeforeRead: false` gives that up: reads then use the index as it stands,
and `codebase_index` is the only refresh path.

Concurrent reads of the same project share one scan instead of queuing a second
one behind the first.

## 2. A partial surface

`surface: 'core'` (default) registers six tools. Registering the whole CLI
operation catalog as tools would cost several times the system prompt.

| Tool | CLI operation | What it answers |
|---|---|---|
| `codebase_projects` | `list_projects` | Which graphs exist, and where their roots are |
| `codebase_status` | `index_status` | Nodes, edges, `indexed_at`, parse problems |
| `codebase_index` | `index_repository` | Build or refresh a graph from a working tree |
| `codebase_search` | `search_graph` | Where a concept or name lives |
| `codebase_snippet` | `get_code_snippet` | The exact indexed source of one symbol |
| `codebase_trace` | `trace_path` | Callers, callees, blast radius |

`surface: 'full'` adds `codebase_coverage` (`check_index_coverage`).
`surface: 'gateway'` registers a single `codebase_memory` tool that lists the
binary's operations and forwards `{tool, args}` to any of them, so nothing
becomes unreachable.

`expose` replaces the selected set with an explicit list of short names
(`search`, `trace`, …) or registered tool names (`codebase_search`, …).

## Command dialects

The CLI exists in two shapes on disk, and the plugin speaks both:

| `commandStyle` | What is executed |
|---|---|
| `canonical` | `<exe> search --query X --json` — the CLI-first fork |
| `compat` | `<exe> cli --quiet search_graph --format json --query X` — the older binary |
| `auto` (default) | `--version` names `codebase-memory-cli` → canonical, otherwise compat |

A canonical call the binary rejects falls back to `compat` once and logs it, so
swapping the binary does not require a settings change. A bare default
`exePath` that is not on `PATH` falls back to `codebase-memory-mcp`.

## Settings

All fields are on the plugin row in **Settings → Plugins → codebase-memory-cli**;
saving one restarts the plugin.

| Field | Default | Meaning |
|---|---|---|
| `surface` | `core` | `core` \| `full` \| `gateway` |
| `expose` | `[]` | Explicit tool names; non-empty replaces the set |
| `exePath` | `codebase-memory-cli` | Binary or absolute path |
| `commandStyle` | `auto` | `auto` \| `canonical` \| `compat` |
| `cwd` | `''` | Working directory; empty = the Session workspace |
| `env` | `{}` | Extra environment, e.g. `CBM_CACHE_DIR` / `CBM_RUNTIME_DIR` |
| `defaultProject` | `''` | Project used when a call omits one |
| `refreshBeforeRead` | `true` | Re-index incrementally before every graph read |
| `indexMode` | `full` | `full` \| `moderate` \| `fast` — mode for refreshes |
| `persistence` | `false` | Also write `.codebase-memory/graph.db.zst` |
| `daemon` | `true` | Run `daemon start` when the plugin loads |
| `toolCallTimeoutMs` | `120000` | Budget for one read |
| `indexTimeoutMs` | `600000` | Budget for one refresh |
| `enabled` | `true` | Register the tools at all |

## Running beside another install

The CLI refuses to run when a daemon of a different version is active — its
*version cohort* check. Two installs on one machine therefore need separate
coordination directories. The bundle patch ships with:

```yaml
env:
  CBM_CACHE_DIR: '…/codebase-memory-cli-data/cache'
  CBM_RUNTIME_DIR: '…/codebase-memory-cli-data/runtime'
```

Change or clear those two values to share one daemon and one graph with every
other codebase-memory client on the machine.

## Verified behaviour and limits

Verified against `codebase-memory-cli dev` (build `e613dc9d9b4a…`) on Windows,
with a 9.5k-node Rust repository:

- `projects`, `status`, `search`, `snippet`, `trace` and `coverage` return
  payload JSON in both dialects; the same query through `canonical` and through
  `compat` yields byte-identical payloads.
- `codebase_index` reported `nodes: 9523 edges: 39481` from a 6.2 s run, read
  back through a follow-up `index_status`.
- One `index .` run costs 3.3 s on a clean tree, 4.1 s after a single edit, and
  4.3 s with `--mode fast` — the figures behind the `refreshBeforeRead` tradeoff.
- `surface: core` registers 6 tools (5.6 kB of schema), `full` 7 (6.5 kB),
  `gateway` 1 that catalogs all 17 operations and forwards `{tool, args}`.
- `--version` reported `codebase-memory-cli dev`, so `commandStyle: auto`
  selected `canonical`.

Limits:

- Every read pays a full index scan. That is the point of the design, not an
  oversight: `refreshBeforeRead: false` is the escape hatch.
- `index_repository` has no `--format`, so `codebase_index` reads its result
  from a follow-up `index_status` rather than from the index call itself.
- `codebase_status` reports the index as it stands and does not refresh it, so
  it stays cheap and answers "what is in here" rather than "what would be".
- `gateway` passthrough puts `format: "json"` inside the temporary args file,
  because `--args-file` overrides every command-line flag.

## Install

Add the package directory in **Plugins → Add plugin**, or:

```sh
dsh plugin --profile <profile> add <absolute package directory>
```
