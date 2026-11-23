# Changelog

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
