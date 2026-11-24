# Changelog

## 0.4.2

- TaskManage shape errors name the call that works (HOJA-822). An unknown top-level field (a
  model guessing `tasks: [...]` or `questions` at the top level) and a missing `operations` now
  answer with `{"operations":[{"key":"t1","op":"create","subject":...}]}`; the task gate's block
  message shows the same call. A delegated run on DeepSeek had retried `tasks` 60 times against a
  bare "unknown top-level field" error and never reached its work.

## 0.4.1

HOJA-817: the skill budget gate no longer blocks every tool when this extension runs on its own. It refills only through `Skill`, which the autogenskills manager registers, and `src/extension/index.ts` does not load that manager, so a Hoja runner's pi (`-e src/extension/index.ts` in its own profile) was blocked after five calls with no way out. The gate now applies only while that manager is loaded (`skillBudgetActive` on `createSwarmBuiltinPipeline`; the runtime passes "the autogenskills budget source exists"). Inside Trebol nothing changes. Test: `.pi/test/runtime/skill-budget-gate.test.ts`.

## 0.4.0

HOJA-802: Pi reports its run state over OSC 7501 (Program Status Protocol rev 0.4) with only this extension loaded, so a Hoja runner can drive `pi -ne -e src/extension/index.ts`.

- `extensions/program-status` (new, wired in `src/extension/index.ts`): ported from Trebol's `extensions/swarm-program-status` (`bb517af`). `session_start` → `idle`, `before_agent_start`/`turn_start` → `working`, `ask_user_question` and extension UI prompts → `blocked` (`kind=question`, `permission` for confirms), `agent_settled` → `done` or `error`, `session_shutdown` → `clear`. Unlike Trebol, `done` waits for `agent_settled`, because hoja-decision can still continue the run from `agent_before_settle`. Sequences carry `app=pi` and go to stderr.
- Gate: `PI_PROGRAM_STATUS=1|0` (what the runner sets), then Trebol's `TREBOL_PROGRAM_STATUS=1|0`, then Trebol's default (stderr is a TTY and `TERM` is not `dumb`).
- One reporter at a time: silent when the host Pi reports natively (TUI mode and the host's pi-tui `ProcessTerminal` has `setProgramStatus`, as in pi 1.1.0 / pi-tui 1.5), silent while Trebol is loaded and on (its own extension reports), and registered once per Pi instance across module copies.
- `.pi/lib/runtime/program-status.ts` and `.pi/test/runtime/program-status.test.ts`: Trebol's OSC 7501 emitter and its suite at `bb517af`, unchanged.
- `.pi/test/ui/program-status.test.ts`: lifecycle, continuation, blocked/resume, error, gate, dedupe and native-deferral cases, asserted through a port of the runner's `Osc7501Parser`.

## 0.3.0

HOJA-799-A-8: Pi waits for a decision answer and continues the same session.

- `extensions/hoja-decision` (new): `hoja_decision_ask` creates a Hoja decision bound to this Pi session (binding from `ctx.sessionManager` and the process, never from the model). The answer is delivered once: as the tool result (`wait_seconds`), at `agent_before_settle` (hold ≤120 s, then a user-role custom message), or, when idle in an interactive session, as a `sendUserMessage` follow-up. `take` is gated locally and by the server's CAS; `delivered` follows the hand-over and `ack` follows the nonce reaching the session's entries. Open decisions are journaled and re-armed on `pi --session` after a crash.
- `.pi/test/tools/hoja-decision.test.ts`: the three stages, double answers, restart and nonce recovery against an in-memory server with the delivery contract.

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
