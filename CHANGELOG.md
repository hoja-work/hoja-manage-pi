# Changelog

## 0.2.0

Synced with Trebol `79861a3` (HOJA-757): agents register work without being reminded.

- `.pi/lib/runtime/work-registration.ts` (new, wired in `swarm-builtin-hooks-runtime.ts`): every user-authored prompt gets one line telling the agent how to register it (create a task, activate an open one, or root vs child when a new request arrives mid-task). At `agent_before_settle`, once per turn, a turn whose acting work left the focused task unreconciled, or did work with no task, is continued with a reminder. It never blocks a tool.
- Hoja publication: a child of a task this chat filed is filed as a sub-issue of its parent's issue by default; `hoja:"local"` opts a step out. Before, children stayed local unless promoted, and no agent ever promoted one.
- `HOJA_RULE` and the TaskManage prompt guidance are a four-step registration protocol: a task for every request that changes things, one child per deliverable, a new task for a new request, and reconcile before ending a reply.

## 0.1.1

Synced `extensions/hoja-mode` and `.pi/lib/claw/hoja.ts` with Trebol `4f7490e` (cloverinternational/trebol#479, HOJA-740).

- Published issues are plain Markdown: the task's text plus an `## Acceptance criteria` checklist. The completion comment is a `**Done.**` report with numbered answers and evidence. No `hoja-task` / `hoja-answer` / `hoja-managed` text, "Tracked by" line, status line or question ids.
- Ownership, lost-create reconciliation and comment dedupe are proved from the journal, a title/body fingerprint and the comment body. Issues in the old format are cleaned on their next sync.
- Priority is sent with `issueCreate`.
- Added Trebol's six hoja-mode suites under `.pi/test/tools` (142 tests), so later syncs are verified here.

## 0.1.0

Initial extraction from Trebol `e09781a`.

- Preserved history for TaskManage core, its 13 test suites, the Pi wrapper, the task browser, the Hoja filing layer and their `.pi/lib` dependencies.
- Added `src/extension/index.ts` composing TaskManage + task browser + Hoja filing as one Pi extension.
- Added build/test configuration: `tsc` over `packages/**/src`, `vitest` over all suites.
