/**
 * HOJA-889: restore tool-call arguments that pi's Anthropic Messages adapter drops.
 *
 * pi-ai's anthropic-messages stream (checked in 1.1.0 and 1.6.1) seeds a tool call's
 * arguments from `content_block_start.content_block.input`. At `content_block_stop` it
 * then overwrites them with `parseToolCallArguments(<concatenated input_json_delta text>)`.
 * When a provider sends the whole input in the start event and no `input_json_delta`,
 * the delta text is empty and parses to `{}` with no `argumentsError`. The call reaches
 * the tool with no arguments, and pi records no error.
 *
 * Fireworks serves `accounts/fireworks/models/deepseek-v4p1-flash-1017` over Anthropic
 * Messages (pi's model catalog). A Builder run on it got
 * `TaskManage: operations is required` nine times in a row. The task gate then blocked
 * every acting tool, so the run deadlocked.
 *
 * Anthropic itself always sends `input: {}` at block start and streams the input as
 * deltas, so this recovery never fires there. It fills in a tool call only when all of
 * these hold: the finished arguments are exactly `{}`, pi recorded no parse error, no
 * input delta arrived, and the start event carried a non-empty object.
 */

export const TOOL_INPUT_RECOVERED_ENTRY = "hoja-tool-input-recovered";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

interface OpenBlock { id: string; name: string; start: unknown; deltas: string }

export interface ToolInputRecoveryAPI {
  on(event: string, handler: (event: any, ctx?: any) => unknown): void;
  appendEntry?(type: string, data: unknown): void;
}

/** Stream-event bookkeeping, separate from pi so it can be tested on recorded events. */
export class ToolInputRecovery {
  private open = new Map<number, OpenBlock>();
  private recovered = new Map<string, { name: string; input: Json }>();

  /** Feed one raw provider stream event (Anthropic Messages shape; other shapes are ignored). */
  onStreamEvent(data: unknown): void {
    if (!isObj(data)) return;
    const index = typeof data.index === "number" ? data.index : undefined;
    switch (data.type) {
      case "message_start":
        this.open.clear();
        return;
      case "content_block_start": {
        const block = data.content_block;
        if (index === undefined || !isObj(block) || block.type !== "tool_use" || typeof block.id !== "string") return;
        this.open.set(index, { id: block.id, name: String(block.name ?? ""), start: block.input, deltas: "" });
        return;
      }
      case "content_block_delta": {
        const delta = data.delta;
        const entry = index === undefined ? undefined : this.open.get(index);
        if (entry && isObj(delta) && delta.type === "input_json_delta" && typeof delta.partial_json === "string") entry.deltas += delta.partial_json;
        return;
      }
      case "content_block_stop": {
        const entry = index === undefined ? undefined : this.open.get(index);
        if (!entry) return;
        this.open.delete(index!);
        if (entry.deltas.trim() === "" && isObj(entry.start) && Object.keys(entry.start).length > 0) {
          this.recovered.set(entry.id, { name: entry.name, input: structuredClone(entry.start) });
        }
        return;
      }
    }
  }

  /**
   * Repair a finished assistant message in place, so the agent loop, which holds the same object,
   * executes the restored arguments and the session transcript records them.
   * Returns what was restored.
   */
  repair(message: unknown): { id: string; name: string; keys: string[] }[] {
    const restored: { id: string; name: string; keys: string[] }[] = [];
    if (!isObj(message) || message.role !== "assistant" || !Array.isArray(message.content)) { this.recovered.clear(); return restored; }
    for (const part of message.content) {
      if (!isObj(part) || part.type !== "toolCall" || typeof part.id !== "string") continue;
      const saved = this.recovered.get(part.id);
      if (!saved) continue;
      const args = part.arguments;
      if (part.argumentsError !== undefined || !isObj(args) || Object.keys(args).length > 0) continue;
      part.arguments = structuredClone(saved.input);
      restored.push({ id: part.id, name: String(part.name ?? saved.name), keys: Object.keys(saved.input) });
    }
    this.recovered.clear();
    return restored;
  }
}

const installed = new WeakSet<object>();

export function registerToolInputRecovery(pi: ToolInputRecoveryAPI): ToolInputRecovery | undefined {
  if (installed.has(pi as object)) return undefined;
  installed.add(pi as object);
  const recovery = new ToolInputRecovery();
  pi.on("provider_stream_event", (event: any) => {
    if (event?.api !== undefined && event.api !== "anthropic-messages") return;
    recovery.onStreamEvent(event?.data);
  });
  pi.on("message_end", (event: any) => {
    const restored = recovery.repair(event?.message);
    // Leave a trace in the session file, so a run's transcript shows where the provider dropped arguments.
    if (restored.length) pi.appendEntry?.(TOOL_INPUT_RECOVERED_ENTRY, { restored });
    return undefined;
  });
  return recovery;
}

export default function toolInputRecovery(pi: ToolInputRecoveryAPI): void {
  registerToolInputRecovery(pi);
}
