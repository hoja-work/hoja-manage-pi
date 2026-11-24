import { afterEach, describe, expect, it } from "vitest";
import programStatus, {
  piReportsStatusNatively,
  programStatusEnabled,
  trebolReportsStatus,
} from "../../../extensions/program-status/extension.ts";
import hojaManagePi from "../../../src/extension/index.ts";

/**
 * The parser the Hoja runner applies to the PTY stream (Hoja-Cloud
 * runner/hoja_runnerd/pty.py, Osc7501Parser + _parse_osc_body), ported line for
 * line so these tests assert what the runner will actually read.
 */
const OSC_RE = /\u001b\]([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g;
function runnerParse(stream: string): Array<Record<string, string | number>> {
  const out: Array<Record<string, string | number>> = [];
  for (const m of stream.matchAll(OSC_RE)) {
    const payload = m[1];
    if (!payload.startsWith("7501;") || payload.length > 4096) continue;
    const body = payload.slice(5).trim();
    if (!body || body === "?") continue;
    const fields: Record<string, string | number> = {};
    for (const part of body.split(":")) {
      const i = part.indexOf("=");
      if (i < 0) continue;
      const key = part.slice(0, i).trim();
      const value = part.slice(i + 1);
      if (key === "progress") fields[key] = Math.trunc(Number(value));
      else if (key === "msg") fields[key] = Buffer.from(value, "base64").toString("utf8");
      else fields[key] = value.trim();
    }
    if (Object.keys(fields).length) out.push(fields);
  }
  return out;
}

function harness(
  env: Record<string, string | undefined> = { PI_PROGRAM_STATUS: "1" },
  register = programStatus,
  hostReports = false,
) {
  const hooks = new Map<string, Function[]>();
  const pi = {
    on: (name: string, fn: Function) => hooks.set(name, [...(hooks.get(name) ?? []), fn]),
    registerTool: () => {},
    registerCommand: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    registerMessageRenderer: () => {},
    getFlag: () => undefined,
    events: { on: () => {}, emit: () => {} },
  };
  let stream = "";
  if (register === programStatus) {
    programStatus(pi, { env, isStderrTTY: () => false, write: (d) => (stream += d), hostReportsStatus: () => hostReports });
  } else {
    register(pi as any);
  }
  const emit = async (name: string, event: any = {}) => {
    for (const fn of hooks.get(name) ?? []) await fn(event, {});
  };
  return { pi, hooks, emit, stream: () => stream, reports: () => runnerParse(stream) };
}

const states = (h: ReturnType<typeof harness>) => h.reports().map((r) => r.state);

describe("program-status (OSC 7501) extension", () => {
  afterEach(() => {
    delete (globalThis as any)[Symbol.for("pi-swarm-trebol-loader-registered")];
    delete (globalThis as any)[Symbol.for("pi-swarm-trebol-mode")];
  });

  it("reports ready -> working -> done -> clear in the format the runner parses", async () => {
    const h = harness();
    await h.emit("session_start");
    await h.emit("before_agent_start", { prompt: "fix the login flow\nmore detail" });
    await h.emit("turn_start");
    await h.emit("agent_before_settle", { outcome: "completed", continue: false });
    await h.emit("agent_settled", { aborted: false });
    await h.emit("session_shutdown");
    expect(states(h)).toEqual(["idle", "working", "working", "done", "clear"]);
    const [ready, working] = h.reports();
    expect(ready).toMatchObject({ state: "idle", app: "pi", msg: "Ready" });
    expect(working.msg).toBe("Working: fix the login flow");
    for (const seq of h.stream().split("\u001b\\").filter(Boolean)) {
      expect(seq.startsWith("\u001b]7501;state=")).toBe(true);
    }
  });

  it("does not report done while another extension continues the run", async () => {
    const h = harness();
    await h.emit("session_start");
    await h.emit("before_agent_start", { prompt: "go" });
    await h.emit("agent_before_settle", { outcome: "completed", continue: true });
    await h.emit("turn_start");
    expect(states(h)).not.toContain("done");
    await h.emit("agent_before_settle", { outcome: "completed", continue: false });
    expect(states(h)).not.toContain("done");
    await h.emit("agent_settled", { aborted: false });
    expect(states(h).at(-1)).toBe("done");
  });

  it("reports blocked for ask_user_question and UI prompts, then resumes", async () => {
    const h = harness();
    await h.emit("session_start");
    await h.emit("before_agent_start", { prompt: "deploy" });
    await h.emit("tool_call", {
      toolName: "ask_user_question",
      input: { questions: [{ id: "q1", text: "Deploy to production now?" }] },
    });
    expect(h.reports().at(-1)).toMatchObject({ state: "blocked", kind: "question", msg: "Deploy to production now?" });
    await h.emit("turn_start");
    expect(h.reports().at(-1)!.state).toBe("blocked");
    await h.emit("tool_result", { toolName: "ask_user_question", isError: false });
    expect(h.reports().at(-1)).toMatchObject({ state: "working", msg: "Working: deploy" });
    await h.emit("ui_prompt_start", { kind: "confirm", title: "Allow rm -rf build?" });
    expect(h.reports().at(-1)).toMatchObject({ state: "blocked", kind: "permission", msg: "Allow rm -rf build?" });
    await h.emit("ui_prompt_end", { kind: "confirm" });
    expect(h.reports().at(-1)!.state).toBe("working");
  });

  it("returns to idle after a UI prompt outside a run", async () => {
    const h = harness();
    await h.emit("session_start");
    await h.emit("ui_prompt_start", { kind: "select", title: "Pick a model" });
    await h.emit("ui_prompt_end", { kind: "select" });
    expect(states(h)).toEqual(["idle", "blocked", "idle"]);
  });

  it("reports error when the run is aborted or fails", async () => {
    const h = harness();
    await h.emit("session_start");
    await h.emit("before_agent_start", { prompt: "x" });
    await h.emit("agent_settled", { aborted: true });
    await h.emit("before_agent_start", { prompt: "y" });
    await h.emit("agent_before_settle", { outcome: "error", continue: false });
    await h.emit("agent_settled", { aborted: false });
    const errors = h.reports().filter((r) => r.state === "error");
    expect(errors.map((r) => r.msg)).toEqual(["Stopped: aborted", "Stopped: error"]);
  });

  it("is gated by PI_PROGRAM_STATUS, then TREBOL_PROGRAM_STATUS, then the TTY", async () => {
    const tty = () => true;
    const noTty = () => false;
    expect(programStatusEnabled({ PI_PROGRAM_STATUS: "1" }, noTty)).toBe(true);
    expect(programStatusEnabled({ PI_PROGRAM_STATUS: "true" }, noTty)).toBe(true);
    expect(programStatusEnabled({ PI_PROGRAM_STATUS: "0", TREBOL_PROGRAM_STATUS: "1" }, tty)).toBe(false);
    expect(programStatusEnabled({ TREBOL_PROGRAM_STATUS: "1" }, noTty)).toBe(true);
    expect(programStatusEnabled({ TREBOL_PROGRAM_STATUS: "0" }, tty)).toBe(false);
    expect(programStatusEnabled({ TERM: "xterm-256color" }, tty)).toBe(true);
    expect(programStatusEnabled({ TERM: "dumb" }, tty)).toBe(false);
    expect(programStatusEnabled({}, noTty)).toBe(false);

    const off = harness({ PI_PROGRAM_STATUS: "0" });
    await off.emit("session_start");
    expect(off.stream()).toBe("");
  });

  it("registers once per Pi instance, even through two entry points", async () => {
    const h = harness();
    programStatus(h.pi, { env: { PI_PROGRAM_STATUS: "1" }, write: () => {} });
    expect(h.hooks.get("session_start")).toHaveLength(1);
  });

  it("stays silent while Trebol is loaded and on, so reports are never doubled", async () => {
    const g = globalThis as any;
    g[Symbol.for("pi-swarm-trebol-loader-registered")] = { busy: false, generation: 0 };
    g[Symbol.for("pi-swarm-trebol-mode")] = "on";
    expect(trebolReportsStatus()).toBe(true);
    const h = harness();
    await h.emit("session_start");
    expect(h.stream()).toBe("");
    g[Symbol.for("pi-swarm-trebol-mode")] = "off";
    await h.emit("session_start");
    expect(states(h)).toEqual(["idle"]);
  });

  it("defers to Pi's native OSC 7501 reporter when the host has one", async () => {
    const h = harness(undefined, programStatus, true);
    await h.emit("session_start");
    await h.emit("before_agent_start", { prompt: "go" });
    await h.emit("agent_settled", { aborted: false });
    expect(h.stream()).toBe("");
  });

  it("probes the host only in TUI mode", async () => {
    expect(await piReportsStatusNatively({ mode: "print" })).toBe(false);
    expect(await piReportsStatusNatively(undefined)).toBe(false);
    // The dev dependency's pi-tui (>= 1.5) has the native reporter.
    expect(await piReportsStatusNatively({ mode: "tui" })).toBe(true);
  });

  it("is registered by the hoja-manage-pi entry point", () => {
    const h = harness(undefined, hojaManagePi as any);
    for (const event of ["session_start", "before_agent_start", "agent_settled", "ui_prompt_start"]) {
      expect(h.hooks.has(event)).toBe(true);
    }
  });
});
