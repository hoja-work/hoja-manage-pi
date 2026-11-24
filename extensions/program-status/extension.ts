/**
 * OSC 7501 program-status reporting for a plain Pi (HOJA-802).
 *
 * Ported from Trebol's `extensions/swarm-program-status` (bb517af) so a Hoja
 * runner can drive `pi -ne -e <hoja-manage-pi>/src/extension/index.ts` with no
 * other extension loaded: the runner's pi profile has `readiness = "osc"` and
 * learns idle/working/blocked/done only from these reports.
 *
 * Wire format (Program Status Protocol rev 0.4), one report per sequence, on
 * stderr (the same PTY the runner reads):
 *   ESC ] 7501 ; state=<s>:app=pi:title=<b64>:msg=<b64> ESC \
 *
 * Lifecycle mapping:
 *   session_start                      -> idle     (ready, awaiting input)
 *   before_agent_start / turn_start    -> working  (running the user's prompt)
 *   ask_user_question tool_call        -> blocked  (kind=question)
 *   ui_prompt_start                    -> blocked  (kind=permission for confirm, else question)
 *   tool_result / ui_prompt_end        -> working  (answer received; idle if no run)
 *   agent_before_settle continue=true  -> working  (a continuation follows)
 *   agent_settled                      -> done     (outcome completed)
 *                                      -> error    (aborted / error)
 *   session_shutdown                   -> clear
 *
 * `done` is sent at `agent_settled`, not at `agent_before_settle` as Trebol
 * does: another extension (hoja-decision) can still continue the run from its
 * own `agent_before_settle` handler, and a runner that saw `done` first would
 * finish a run that is still going. `agent_settled` fires only once nothing
 * else will run.
 *
 * Gate (first match wins):
 *   PI_PROGRAM_STATUS=1|true / 0|false       (set by the Hoja runner)
 *   TREBOL_PROGRAM_STATUS=1|true / 0|false   (Trebol's override, honoured too)
 *   otherwise: stderr is a TTY and TERM is not "dumb" (Trebol's default)
 *
 * No double reports:
 *   - Pi's own TUI reports OSC 7501 natively when its terminal has
 *     `setProgramStatus` (pi 1.1.0 / pi-tui 1.5, gated by the same
 *     PI_PROGRAM_STATUS). In that case (mode "tui" on such a host) this
 *     extension stays silent for the session and Pi is the single reporter;
 *     it only fills in on hosts without the native reporter.
 *   - while Trebol is loaded and on, its own swarm-program-status reports;
 *   - one registration per Pi instance across every loaded copy of this
 *     module (a global registry, not a module-local set).
 */

import { ProgramStatusReporter, type ProgramStatusKind } from "../../.pi/lib/runtime/program-status.ts";

export const PROGRAM_STATUS_APP = "pi";
const REGISTRY = Symbol.for("hoja-manage-pi.program-status.registered");
const TREBOL_LOADER = Symbol.for("pi-swarm-trebol-loader-registered");
const TREBOL_MODE = Symbol.for("pi-swarm-trebol-mode");
const ASK_TOOL = "ask_user_question";

type Env = Record<string, string | undefined>;

export interface ProgramStatusOptions {
  env?: Env;
  isStderrTTY?: () => boolean;
  write?: (data: string) => void;
  /** Whether the host Pi reports OSC 7501 itself. Defaults to probing the host's pi-tui. */
  hostReportsStatus?: (ctx: any) => boolean | Promise<boolean>;
}

function override(value: string | undefined): boolean | undefined {
  const v = value?.trim().toLowerCase();
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return undefined;
}

/** Whether this process should emit OSC 7501 reports. */
export function programStatusEnabled(env: Env, isStderrTTY: () => boolean): boolean {
  return (
    override(env.PI_PROGRAM_STATUS) ??
    override(env.TREBOL_PROGRAM_STATUS) ??
    (isStderrTTY() && env.TERM !== "dumb")
  );
}

/** Trebol's loader is registered and on, so Trebol's swarm-program-status owns the reports. */
export function trebolReportsStatus(): boolean {
  const g = globalThis as any;
  return Boolean(g[TREBOL_LOADER]) && g[TREBOL_MODE] !== "off";
}

/**
 * Pi's interactive mode reports program status itself when its terminal
 * implements `setProgramStatus`. Pi's extension loader maps
 * `@earendil-works/pi-tui` to the host's own copy, so this probes the Pi that
 * is actually running, not this package's dev dependency.
 */
export async function piReportsStatusNatively(ctx: any): Promise<boolean> {
  if (ctx?.mode !== "tui") return false;
  try {
    const tui: any = await import("@earendil-works/pi-tui");
    return typeof tui?.ProcessTerminal?.prototype?.setProgramStatus === "function";
  } catch {
    return false;
  }
}

function firstLine(text: unknown, maxLength = 160): string {
  const line = String(text ?? "").split(/\r?\n/)[0].trim();
  const chars = Array.from(line);
  return chars.length > maxLength ? `${chars.slice(0, maxLength - 1).join("")}…` : line;
}

function askQuestionText(event: any): string {
  const questions = event?.input?.questions;
  const text = Array.isArray(questions) ? firstLine(questions[0]?.text) : "";
  return text || "Waiting for your answer";
}

function registry(): WeakSet<object> {
  const g = globalThis as any;
  return (g[REGISTRY] ??= new WeakSet<object>());
}

export default function programStatus(pi: any, options: ProgramStatusOptions = {}): void {
  const seen = registry();
  if (seen.has(pi)) return;
  seen.add(pi);

  const env = options.env ?? process.env;
  const isStderrTTY = options.isStderrTTY ?? (() => Boolean(process.stderr?.isTTY));
  let reporter: ProgramStatusReporter | null = null;
  let lastWorkingMsg = "Working";
  let outcome: string | undefined;
  let blockedBy = 0;
  let running = false;
  let hostReports = false;
  const probeHost = options.hostReportsStatus ?? piReportsStatusNatively;

  const status = (): ProgramStatusReporter =>
    (reporter ??= new ProgramStatusReporter({
      app: PROGRAM_STATUS_APP,
      title: "Pi",
      env,
      enabled: programStatusEnabled(env, isStderrTTY),
      ...(options.write ? { write: options.write } : {}),
    }));

  // Best-effort and cosmetic: never disturb the agent loop or the TUI.
  const emit = (fn: (r: ProgramStatusReporter) => void): void => {
    try {
      if (hostReports || trebolReportsStatus()) return;
      fn(status());
    } catch {
      /* ProgramStatusReporter.report never throws */
    }
  };

  const markWorking = (msg: string) => {
    lastWorkingMsg = msg;
    emit((r) => r.working(msg));
  };
  const block = (kind: ProgramStatusKind, msg: string) => {
    blockedBy += 1;
    emit((r) => r.blocked(kind, msg));
  };
  const unblock = () => {
    if (blockedBy === 0) return;
    blockedBy -= 1;
    if (blockedBy > 0) return;
    if (running) emit((r) => r.working(lastWorkingMsg));
    else emit((r) => r.idle("Ready"));
  };

  pi.on("session_start", async (_event: any, ctx: any) => {
    reporter = null;
    try {
      hostReports = Boolean(await probeHost(ctx));
    } catch {
      hostReports = false;
    }
    lastWorkingMsg = "Working";
    outcome = undefined;
    blockedBy = 0;
    running = false;
    emit((r) => r.idle("Ready"));
  });

  pi.on("before_agent_start", (event: any) => {
    outcome = undefined;
    running = true;
    const prompt = firstLine(event?.prompt);
    markWorking(prompt ? `Working: ${prompt}` : "Working");
  });

  pi.on("turn_start", () => {
    if (blockedBy === 0) emit((r) => r.working(lastWorkingMsg));
  });

  pi.on("tool_call", (event: any) => {
    if (event?.toolName === ASK_TOOL) block("question", askQuestionText(event));
  });

  pi.on("tool_result", (event: any) => {
    if (event?.toolName === ASK_TOOL) unblock();
  });

  pi.on("ui_prompt_start", (event: any) => {
    const title = firstLine(event?.title);
    block(event?.kind === "confirm" ? "permission" : "question", title || "Waiting for your answer");
  });

  pi.on("ui_prompt_end", () => unblock());

  pi.on("agent_before_settle", (event: any) => {
    if (event?.continue) {
      emit((r) => r.working(lastWorkingMsg));
      return;
    }
    outcome = typeof event?.outcome === "string" ? event.outcome : undefined;
  });

  pi.on("agent_settled", (event: any) => {
    blockedBy = 0;
    running = false;
    const result = event?.aborted ? "aborted" : (outcome ?? "completed");
    outcome = undefined;
    if (result === "completed") emit((r) => r.done("Finished"));
    else emit((r) => r.error(`Stopped: ${firstLine(result) || "unknown"}`));
  });

  pi.on("session_shutdown", () => {
    try {
      emit((r) => r.clear());
    } finally {
      reporter = null;
    }
  });
}
