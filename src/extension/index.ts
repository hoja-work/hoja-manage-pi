/**
 * hoja-manage-pi — single Pi entry point.
 *
 * Composition, in registration order:
 *   1. TaskManage core (packages/tools/taskmanage) — the task engine and its hooks.
 *   2. The read-only task browser (extensions/task-browser), opened by /tasks.
 *   3. Hoja filing (extensions/hoja-mode), which listens for `tool_result` events
 *      whose toolName is "TaskManage" and publishes coarse tasks as Hoja issues.
 *   4. Hoja decisions (extensions/hoja-decision): `hoja_decision_ask` asks a person and the answer comes back into
 *      this same session exactly once (in the tool call, at settle, or as a follow-up when idle). HOJA-799-A-8.
 *   5. Program status (extensions/program-status): reports Pi's run state (idle/working/blocked/done/error)
 *      over OSC 7501 so a Hoja runner can drive a plain `pi -ne -e <this file>`. Gated by PI_PROGRAM_STATUS. HOJA-802.
 *
 * The Hoja layer never imports TaskManage internals: it consumes the structured
 * `details.batch` envelope TaskManage already emits. Disable it at runtime with
 * /hoja off; the TaskManage core keeps working without a Hoja project.
 */
import taskManageExtension from "../../extensions/taskmanage/extension.ts";
import hojaMode from "../../extensions/hoja-mode/extension.ts";
import hojaDecision from "../../extensions/hoja-decision/extension.ts";
import programStatus from "../../extensions/program-status/extension.ts";

export default function hojaManagePi(pi: any): void {
  taskManageExtension(pi);
  hojaMode(pi);
  hojaDecision(pi);
  programStatus(pi);
}

export { registerTaskManageExtension } from "../../extensions/taskmanage/extension.ts";
export { openTaskBrowser, TaskBrowserView } from "../../extensions/task-browser/extension.ts";
export { registerHojaMode, HOJA_RULE } from "../../extensions/hoja-mode/extension.ts";
export { registerHojaDecision, HOJA_DECISION_ASK_CONTRACT } from "../../extensions/hoja-decision/extension.ts";
export { programStatusEnabled, PROGRAM_STATUS_APP } from "../../extensions/program-status/extension.ts";
