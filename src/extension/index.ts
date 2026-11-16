/**
 * hoja-manage-pi — single Pi entry point.
 *
 * Composition, in registration order:
 *   1. TaskManage core (packages/tools/taskmanage) — the task engine and its hooks.
 *   2. The read-only task browser (extensions/task-browser), opened by /tasks.
 *   3. Hoja filing (extensions/hoja-mode), which listens for `tool_result` events
 *      whose toolName is "TaskManage" and publishes coarse tasks as Hoja issues.
 *
 * The Hoja layer never imports TaskManage internals: it consumes the structured
 * `details.batch` envelope TaskManage already emits. Disable it at runtime with
 * /hoja off; the TaskManage core keeps working without a Hoja project.
 */
import taskManageExtension from "../../extensions/taskmanage/extension.ts";
import hojaMode from "../../extensions/hoja-mode/extension.ts";

export default function hojaManagePi(pi: any): void {
  taskManageExtension(pi);
  hojaMode(pi);
}

export { registerTaskManageExtension } from "../../extensions/taskmanage/extension.ts";
export { openTaskBrowser, TaskBrowserView } from "../../extensions/task-browser/extension.ts";
export { registerHojaMode, HOJA_RULE } from "../../extensions/hoja-mode/extension.ts";
