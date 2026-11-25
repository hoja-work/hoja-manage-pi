/**
 * HOJA-889: a Builder run on Fireworks DeepSeek (Anthropic Messages) got `{}` as
 * TaskManage's arguments nine times and the task gate then blocked every tool.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerTaskManageExtension } from "../../../../extensions/taskmanage/extension.ts";
import { registerToolInputRecovery, ToolInputRecovery, TOOL_INPUT_RECOVERED_ENTRY } from "../../../../extensions/tool-input-recovery/extension.ts";
import { establishedHookContext } from "../../../../.pi/test/support/hook-session.ts";

type Handler = (event: any, ctx?: any) => unknown;
let savedSubagentEnv: string | undefined;
beforeEach(() => { savedSubagentEnv = process.env.PI_SWARM_SUBAGENT; delete process.env.PI_SWARM_SUBAGENT; });
afterEach(() => { if (savedSubagentEnv === undefined) delete process.env.PI_SWARM_SUBAGENT; else process.env.PI_SWARM_SUBAGENT = savedSubagentEnv; });

function fakePi() {
  const tools: any[] = []; const handlers = new Map<string, Handler[]>(); const appended: any[] = [];
  const pi = {
    registerTool(tool: unknown) { tools.push(tool); },
    appendEntry(type: string, data: unknown) { appended.push({ type, data }); },
    on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
  };
  return { pi, tools, handlers, appended };
}

const OPS = { operations: [{ key: "t1", op: "create", subject: "Ship it", status: "in_progress", active: true, questions: [{ id: "q", text: "Shipped?" }] }] };

/** Anthropic Messages stream events for one tool call, as Fireworks would send them. */
function toolUseStream(id: string, start: unknown, deltas: string[] = []) {
  return [
    { type: "message_start", message: { id: "msg", role: "assistant", content: [] } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "TaskManage", input: start } },
    ...deltas.map(partial_json => ({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json } })),
    { type: "content_block_stop", index: 0 },
  ];
}
/** What pi-ai's adapter leaves after content_block_stop: finish("") overwrites the start input with {}. */
const piFinished = (id: string, args: unknown = {}) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "TaskManage", arguments: args }] });

describe("tool input recovery (HOJA-889)", () => {
  it("restores input sent only in content_block_start and records it in the session", async () => {
    const { pi, handlers, appended } = fakePi();
    registerToolInputRecovery(pi);
    for (const data of toolUseStream("call_1", OPS)) for (const h of handlers.get("provider_stream_event")!) await h({ type: "provider_stream_event", api: "anthropic-messages", data });
    const message = piFinished("call_1");
    for (const h of handlers.get("message_end")!) await h({ type: "message_end", message });
    expect((message.content[0] as any).arguments).toEqual(OPS);
    expect(appended).toEqual([{ type: TOOL_INPUT_RECOVERED_ENTRY, data: { restored: [{ id: "call_1", name: "TaskManage", keys: ["operations"] }] } }]);
  });

  it("leaves normal Anthropic streaming alone (empty start, input in deltas)", () => {
    const r = new ToolInputRecovery();
    for (const data of toolUseStream("c", {}, ['{"operations":', "[]}"])) r.onStreamEvent(data);
    const message = piFinished("c", { operations: [] });
    expect(r.repair(message)).toEqual([]);
    expect((message.content[0] as any).arguments).toEqual({ operations: [] });
  });

  it("never overrides a parse error or arguments the adapter already has", () => {
    const r = new ToolInputRecovery();
    for (const data of toolUseStream("c", OPS)) r.onStreamEvent(data);
    const broken = { role: "assistant", content: [{ type: "toolCall", id: "c", name: "TaskManage", arguments: {}, argumentsError: "bad json" }] };
    expect(r.repair(broken)).toEqual([]);
    for (const data of toolUseStream("d", OPS, [""])) r.onStreamEvent(data);
    const filled = piFinished("d", { mode: "atomic" });
    expect(r.repair(filled)).toEqual([]);
    expect((filled.content[0] as any).arguments).toEqual({ mode: "atomic" });
  });

  it("ignores other APIs' stream events", async () => {
    const { pi, handlers } = fakePi();
    registerToolInputRecovery(pi);
    for (const data of toolUseStream("x", OPS)) for (const h of handlers.get("provider_stream_event")!) await h({ api: "openai-completions", data });
    const message = piFinished("x");
    for (const h of handlers.get("message_end")!) await h({ message });
    expect((message.content[0] as any).arguments).toEqual({});
  });
});

describe("task gate does not deadlock when TaskManage arguments are lost (HOJA-889)", () => {
  async function run(handlers: Map<string, Handler[]>, name: string, event: any, ctx: any) {
    let out: any;
    for (const h of handlers.get(name) ?? []) out = (await h(event, ctx)) ?? out;
    return out;
  }
  async function taskManageCall(runtime: ReturnType<typeof fakePi>, ctx: any, id: string, input: any) {
    const tool = runtime.tools.find((t: any) => t.name === "TaskManage");
    let result: any; let isError = false;
    try { result = await tool.execute(id, input); isError = result.isError === true; }
    catch (e) { isError = true; result = { content: [{ type: "text", text: (e as Error).message }] }; }
    await run(runtime.handlers, "tool_result", { toolName: "TaskManage", toolCallId: id, input, content: result.content, isError }, ctx);
    return result.content[0].text as string;
  }

  it("suspends the gate after repeated empty-argument failures and re-arms it once a call arrives", async () => {
    const runtime = fakePi();
    registerTaskManageExtension(runtime.pi as any, { enforcementMode: "block" });
    const ctx = establishedHookContext();
    const write = (id: string) => run(runtime.handlers, "tool_call", { toolName: "write", toolCallId: id, input: {} }, ctx);

    expect(await write("w0")).toMatchObject({ block: true });
    expect(await taskManageCall(runtime, ctx, "e1", {})).toContain("no arguments at all");
    expect(await write("w1")).toMatchObject({ block: true });
    await taskManageCall(runtime, ctx, "e2", {});
    const open = await write("w2");
    expect(open?.block).not.toBe(true);

    // A TaskManage call that carries arguments (even an invalid one) re-arms the gate.
    await taskManageCall(runtime, ctx, "bad", { mode: "atomic" });
    expect(await write("w3")).toMatchObject({ block: true });
    await taskManageCall(runtime, ctx, "ok", OPS);
    expect((await write("w4"))?.block).not.toBe(true);
  });
});
