# hoja-manage-pi

Hoja-backed task management for [Pi](https://github.com/hoja-work). One Pi extension that registers:

- **TaskManage** — the task engine (create/update/get/list, acceptance questions with evidence revalidation, hooks that gate tool use on a focused task).
- **Task browser** — read-only TUI overlay opened with `/tasks`.
- **Hoja filing** — coarse tasks publish automatically to a [Hoja](https://hoja.app) issue; steps stay local. Read-only `hoja_list` / `hoja_get` answer "what should I do next".

## Provenance

Extracted from `cloverinternational/trebol` at commit `e09781a` with `git filter-repo`, so per-file history is preserved (148 commits). No source file was rewritten except the new composition entry.

| Path here | Upstream |
| --- | --- |
| `packages/tools/taskmanage/src` | `packages/tools/taskmanage/src` |
| `packages/tools/taskmanage/test` | `packages/tools/taskmanage/test` (13 suites, unchanged) |
| `packages/tools/mcp` | `packages/tools/mcp` |
| `packages/runtime/core` | `packages/runtime/core` |
| `extensions/taskmanage` | `extensions/taskmanage` (Pi wrapper) |
| `extensions/task-browser` | `extensions/task-browser` |
| `extensions/hoja-mode` | `extensions/hoja-mode` (Hoja filing) |
| `.pi/lib/**` | runtime, policy, ui, tools and claw helpers the above import |
| `src/extension/index.ts` | **new** — single entry composing the three extensions |

Files keep their upstream paths (rather than being relocated under `src/`) so that `git log` on any file is the real history and upstream diffs apply cleanly.

## Architecture

```mermaid
flowchart LR
  subgraph Pi["Pi runtime"]
    E["src/extension/index.ts"]
  end
  subgraph Core["TaskManage core"]
    TM["packages/tools/taskmanage"]
    BR["extensions/task-browser"]
  end
  subgraph Hoja["Hoja layer"]
    HM["extensions/hoja-mode"]
    HC[("Hoja API")]
  end
  U(["User"]) -->|"prompt / /tasks"| E
  E --> TM
  E --> BR
  E --> HM
  TM -.->|"tool_result event, details.batch"| HM
  HM -->|"HTTPS"| HC
```

The Hoja layer does not import TaskManage internals; it observes `tool_result` events whose `toolName` is `TaskManage` and reads the structured `details.batch` envelope. That is why the core works with no Hoja project configured, and `/hoja off` disables filing without touching the task engine.

## Install

```bash
pi extension add /path/to/hoja-manage-pi
```

Then in a session: `TaskManage` is available, `/tasks` opens the browser, `/hoja` toggles publication.

## Build and test

```bash
npm install
npm run build   # tsc, packages/**/src -> dist
npm test        # vitest, 175 tests
```

`extensions/**` are not type-checked here: Pi loads them at runtime, exactly as Trebol does. `tsc` covers `packages/**/src`, matching upstream's build scope.

### Known pre-existing failure

`packages/tools/mcp/test/index.test.ts > turns a closed server pipe into a transport failure` times out under full-suite parallelism and passes in isolation. Trebol's own full suite fails on the same test (verified on `e09781a`), so this is upstream behavior, not a port regression.

## Configuration

Hoja filing resolves a project in this order: this chat's `hoja_project` selection, then `.pi/config/hoja.json` in the repository (`{"project":"<exact name>"}`).

## License

MIT — see [LICENSE](LICENSE). The extracted code originates from `cloverinternational/trebol`, which ships no license; this repository is released under MIT by its owner.
