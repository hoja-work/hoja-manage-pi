import { describe, expect, it } from "vitest";
import { createSwarmBuiltinPipeline, type HookTask } from "../../lib/runtime/swarm-builtin-hooks.ts";

// HOJA-817: hoja-manage-pi alone has no `Skill` tool, so the skill budget must not block it.
const focused: HookTask[] = [{ id: "1", subject: "work", status: "in_progress", active: true } as any];
const budgetHook = (active?: () => boolean) => {
  const p: any = createSwarmBuiltinPipeline({ session: "s", tasks: () => focused, skillBudgetActive: active });
  return p.options.preHooks.find((h: any) => h.name === p.hooks.budgetHook.name);
};

describe("skill budget gate", () => {
  it("never blocks when the budget is inactive (no autogenskills manager)", () => {
    const hook = budgetHook(() => false);
    for (let i = 0; i < 50; i++) expect(hook.run({ toolName: "bash", params: {} } as any, focused, {} as any, "s").block).toBeFalsy();
  });
  it("still blocks after the fallback budget when active", () => {
    const hook = budgetHook(() => true);
    const results = Array.from({ length: 50 }, () => hook.run({ toolName: "bash", params: {} } as any, focused, {} as any, "s"));
    expect(results.some(r => r.block)).toBe(true);
  });
});
