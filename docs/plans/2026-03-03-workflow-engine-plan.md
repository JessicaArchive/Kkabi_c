# Workflow Engine Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a general-purpose workflow engine that composes existing agents into multi-step pipelines with dependency-based execution order and context passing between steps.

**Architecture:** New `src/workflow/` module with store (CRUD for workflows.json) and engine (step execution with dependency resolution). Integrates with existing agent store, Claude queue, cron scheduler, command system, and context builder.

**Tech Stack:** TypeScript, Zod validation, node-cron, existing Claude CLI runner

---

### Task 1: Add Workflow Types

**Files:**
- Modify: `src/types.ts:60-93`

**Step 1: Add WorkflowStep, WorkflowRunState, and Workflow interfaces to types.ts**

Add after the existing `Agent` interface (line 59):

```typescript
export interface WorkflowStep {
  id: string;
  agentId: string;
  prompt: string;
  promptPath?: string;
  dependsOn?: string[];
  timeoutMs?: number;
}

export interface WorkflowRunState {
  lastRunAtMs?: number;
  lastStatus?: "ok" | "error" | "partial";
  lastDurationMs?: number;
  completedSteps?: string[];
  failedStep?: string;
  lastError?: string;
}

export interface Workflow {
  id: string;
  name: string;
  enabled: boolean;
  steps: WorkflowStep[];
  channelType: ChannelType;
  chatId: string;
  state?: WorkflowRunState;
}
```

**Step 2: Add workflowId to CronJob interface**

Add `workflowId?: string;` in the Execution section of CronJob (after `agentId` on line 82):

```typescript
  // Execution
  prompt: string;
  promptPath?: string;
  agentId?: string;
  workflowId?: string;    // <-- new
  model?: string;
```

**Step 3: Run typecheck**

Run: `cd /mnt/c/Users/kyjs0/Documents/Work/AI_Platform/Kkabi_c && npx tsc --noEmit`
Expected: PASS (no errors, types are not used yet)

**Step 4: Commit**

```bash
git add src/types.ts
git commit -m "feat: add Workflow, WorkflowStep, WorkflowRunState types"
```

---

### Task 2: Workflow Store (CRUD)

**Files:**
- Create: `src/workflow/store.ts`
- Create: `src/workflow/store.test.ts`

**Step 1: Write the failing tests**

Create `src/workflow/store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import {
  loadWorkflows,
  getWorkflow,
  saveWorkflow,
  removeWorkflow,
  reloadWorkflows,
} from "./store.js";
import type { Workflow } from "../types.js";

describe("workflow store", () => {
  const testIds: string[] = [];

  function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
    return {
      id: "test-wf",
      name: "Test Workflow",
      enabled: true,
      steps: [
        { id: "step1", agentId: "agent1", prompt: "Do something" },
      ],
      channelType: "slack",
      chatId: "C123",
      ...overrides,
    };
  }

  function saveTestWorkflow(wf: Workflow) {
    testIds.push(wf.id);
    return saveWorkflow(wf);
  }

  beforeEach(() => {
    for (const id of testIds) {
      removeWorkflow(id);
    }
    testIds.length = 0;
    reloadWorkflows();
  });

  it("saves and retrieves a workflow", () => {
    const wf = makeWorkflow({ id: "test-save" });
    saveTestWorkflow(wf);
    reloadWorkflows();
    const found = getWorkflow("test-save");
    expect(found).toBeDefined();
    expect(found!.id).toBe("test-save");
    expect(found!.name).toBe("Test Workflow");
    expect(found!.steps).toHaveLength(1);
  });

  it("updates an existing workflow", () => {
    saveTestWorkflow(makeWorkflow({ id: "test-upd", name: "Original" }));
    saveTestWorkflow(makeWorkflow({ id: "test-upd", name: "Updated" }));
    reloadWorkflows();
    expect(getWorkflow("test-upd")!.name).toBe("Updated");
  });

  it("removes a workflow", () => {
    saveTestWorkflow(makeWorkflow({ id: "test-rm" }));
    expect(removeWorkflow("test-rm")).toBe(true);
    reloadWorkflows();
    expect(getWorkflow("test-rm")).toBeUndefined();
  });

  it("returns false when removing non-existent workflow", () => {
    expect(removeWorkflow("test-nope-999")).toBe(false);
  });

  it("getWorkflow returns undefined for missing id", () => {
    expect(getWorkflow("test-missing-999")).toBeUndefined();
  });

  it("loadWorkflows returns an array", () => {
    expect(Array.isArray(loadWorkflows())).toBe(true);
  });

  it("toggleWorkflow flips enabled state", async () => {
    const { toggleWorkflow } = await import("./store.js");
    saveTestWorkflow(makeWorkflow({ id: "test-tog", enabled: true }));
    const toggled = toggleWorkflow("test-tog");
    expect(toggled).not.toBeNull();
    expect(toggled!.enabled).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /mnt/c/Users/kyjs0/Documents/Work/AI_Platform/Kkabi_c && npx vitest run src/workflow/store.test.ts`
Expected: FAIL — module not found

**Step 3: Implement workflow store**

Create `src/workflow/store.ts`:

```typescript
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { z } from "zod";
import type { Workflow } from "../types.js";

const WorkflowStepSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  prompt: z.string().min(1),
  promptPath: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
  timeoutMs: z.number().positive().optional(),
});

const WorkflowRunStateSchema = z.object({
  lastRunAtMs: z.number().optional(),
  lastStatus: z.enum(["ok", "error", "partial"]).optional(),
  lastDurationMs: z.number().optional(),
  completedSteps: z.array(z.string()).optional(),
  failedStep: z.string().optional(),
  lastError: z.string().optional(),
});

const WorkflowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  steps: z.array(WorkflowStepSchema).min(1),
  channelType: z.enum(["slack", "github", "gchat"]),
  chatId: z.string().min(1),
  state: WorkflowRunStateSchema.optional(),
});

const WorkflowsFileSchema = z.object({
  version: z.literal(1),
  workflows: z.array(WorkflowSchema),
});

const WORKFLOWS_FILE = resolve(process.cwd(), "data", "workflows.json");

let cache: Workflow[] | null = null;

export function loadWorkflows(): Workflow[] {
  if (cache) return cache;
  if (!existsSync(WORKFLOWS_FILE)) {
    cache = [];
    return cache;
  }
  const raw = readFileSync(WORKFLOWS_FILE, "utf-8");
  const parsed = WorkflowsFileSchema.parse(JSON.parse(raw));
  cache = parsed.workflows;
  return cache;
}

export function getWorkflow(id: string): Workflow | undefined {
  return loadWorkflows().find((w) => w.id === id);
}

export function saveWorkflow(workflow: Workflow): void {
  const workflows = loadWorkflows();
  const idx = workflows.findIndex((w) => w.id === workflow.id);
  if (idx >= 0) {
    workflows[idx] = workflow;
  } else {
    workflows.push(workflow);
  }
  writeWorkflows(workflows);
}

export function removeWorkflow(id: string): boolean {
  const workflows = loadWorkflows();
  const idx = workflows.findIndex((w) => w.id === id);
  if (idx === -1) return false;
  workflows.splice(idx, 1);
  writeWorkflows(workflows);
  return true;
}

export function toggleWorkflow(id: string): Workflow | null {
  const workflows = loadWorkflows();
  const wf = workflows.find((w) => w.id === id);
  if (!wf) return null;
  wf.enabled = !wf.enabled;
  writeWorkflows(workflows);
  return wf;
}

export function reloadWorkflows(): Workflow[] {
  cache = null;
  return loadWorkflows();
}

function writeWorkflows(workflows: Workflow[]): void {
  mkdirSync(dirname(WORKFLOWS_FILE), { recursive: true });
  const data = { version: 1, workflows };
  writeFileSync(WORKFLOWS_FILE, JSON.stringify(data, null, 2), "utf-8");
  cache = workflows;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /mnt/c/Users/kyjs0/Documents/Work/AI_Platform/Kkabi_c && npx vitest run src/workflow/store.test.ts`
Expected: PASS (all 7 tests)

**Step 5: Run full typecheck**

Run: `cd /mnt/c/Users/kyjs0/Documents/Work/AI_Platform/Kkabi_c && npx tsc --noEmit`
Expected: PASS

**Step 6: Commit**

```bash
git add src/workflow/store.ts src/workflow/store.test.ts
git commit -m "feat: add workflow store with CRUD operations and tests"
```

---

### Task 3: Workflow Engine

**Files:**
- Create: `src/workflow/engine.ts`
- Create: `src/workflow/engine.test.ts`

**Step 1: Write failing tests for the engine**

Create `src/workflow/engine.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { resolveExecutionOrder } from "./engine.js";
import type { WorkflowStep } from "../types.js";

describe("resolveExecutionOrder", () => {
  it("returns single step as one batch", () => {
    const steps: WorkflowStep[] = [
      { id: "a", agentId: "agent1", prompt: "do A" },
    ];
    const batches = resolveExecutionOrder(steps);
    expect(batches).toEqual([["a"]]);
  });

  it("groups independent steps into one batch", () => {
    const steps: WorkflowStep[] = [
      { id: "a", agentId: "agent1", prompt: "do A" },
      { id: "b", agentId: "agent2", prompt: "do B" },
    ];
    const batches = resolveExecutionOrder(steps);
    expect(batches).toEqual([["a", "b"]]);
  });

  it("creates sequential batches for dependencies", () => {
    const steps: WorkflowStep[] = [
      { id: "a", agentId: "agent1", prompt: "do A" },
      { id: "b", agentId: "agent2", prompt: "do B", dependsOn: ["a"] },
    ];
    const batches = resolveExecutionOrder(steps);
    expect(batches).toEqual([["a"], ["b"]]);
  });

  it("handles diamond dependencies", () => {
    const steps: WorkflowStep[] = [
      { id: "a", agentId: "a1", prompt: "A" },
      { id: "b", agentId: "a2", prompt: "B", dependsOn: ["a"] },
      { id: "c", agentId: "a3", prompt: "C", dependsOn: ["a"] },
      { id: "d", agentId: "a4", prompt: "D", dependsOn: ["b", "c"] },
    ];
    const batches = resolveExecutionOrder(steps);
    expect(batches).toEqual([["a"], ["b", "c"], ["d"]]);
  });

  it("throws on circular dependency", () => {
    const steps: WorkflowStep[] = [
      { id: "a", agentId: "a1", prompt: "A", dependsOn: ["b"] },
      { id: "b", agentId: "a2", prompt: "B", dependsOn: ["a"] },
    ];
    expect(() => resolveExecutionOrder(steps)).toThrow("Circular");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /mnt/c/Users/kyjs0/Documents/Work/AI_Platform/Kkabi_c && npx vitest run src/workflow/engine.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the workflow engine**

Create `src/workflow/engine.ts`:

```typescript
import {
  readFileSync,
  appendFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import type { Workflow, WorkflowStep, WorkflowRunState, ClaudeResult, ChannelType } from "../types.js";
import { getAgent } from "../agents/store.js";
import { getWorkflow, saveWorkflow, loadWorkflows } from "./store.js";
import { enqueue } from "../claude/queue.js";

const RUNS_DIR = resolve(process.cwd(), "data", "workflow-runs");

// --- Send callback (same pattern as cron) ---

type SendCallback = (channelType: ChannelType, chatId: string, text: string) => Promise<void>;
let sendCallback: SendCallback | null = null;

export function setWorkflowSendCallback(cb: SendCallback): void {
  sendCallback = cb;
}

// --- Dependency resolution (exported for testing) ---

export function resolveExecutionOrder(steps: WorkflowStep[]): string[][] {
  const batches: string[][] = [];
  const resolved = new Set<string>();
  const stepMap = new Map(steps.map((s) => [s.id, s]));
  let remaining = steps.length;

  while (remaining > 0) {
    const batch: string[] = [];

    for (const step of steps) {
      if (resolved.has(step.id)) continue;
      const deps = step.dependsOn ?? [];
      if (deps.every((d) => resolved.has(d))) {
        batch.push(step.id);
      }
    }

    if (batch.length === 0) {
      throw new Error("Circular dependency detected in workflow steps");
    }

    for (const id of batch) {
      resolved.add(id);
    }
    remaining -= batch.length;
    batches.push(batch);
  }

  return batches;
}

// --- Step execution ---

function resolveStepPrompt(step: WorkflowStep): string {
  if (step.promptPath) {
    const filePath = resolve(process.cwd(), step.promptPath);
    if (existsSync(filePath)) {
      return readFileSync(filePath, "utf-8");
    }
    console.error(`[Workflow] Prompt file not found: ${filePath}, falling back to inline prompt`);
  }
  return step.prompt;
}

function buildStepPrompt(
  step: WorkflowStep,
  prevResults: Map<string, ClaudeResult>,
): string {
  const parts: string[] = [];

  // Inject previous step outputs for dependencies
  const deps = step.dependsOn ?? [];
  for (const depId of deps) {
    const prev = prevResults.get(depId);
    if (prev?.output) {
      parts.push(`[PREVIOUS STEP: ${depId}]\n${prev.output}`);
    }
  }

  // Agent persona
  const agent = getAgent(step.agentId);
  if (agent?.persona) {
    parts.push(`[PERSONA]\n${agent.persona}`);
  }

  // Step prompt
  parts.push(`[STEP PROMPT]\n${resolveStepPrompt(step)}`);

  return parts.join("\n\n");
}

async function executeStep(
  step: WorkflowStep,
  workflow: Workflow,
  prevResults: Map<string, ClaudeResult>,
): Promise<{ stepId: string; result: ClaudeResult; durationMs: number }> {
  const startMs = Date.now();
  const agent = getAgent(step.agentId);

  const prompt = buildStepPrompt(step, prevResults);

  const model = agent?.model;
  const workingDir = agent?.workingDir;
  const timeoutMs = step.timeoutMs ?? agent?.timeoutMs;

  const { promise } = enqueue({
    prompt,
    chatId: workflow.chatId,
    channel: workflow.channelType,
    model,
    workingDir,
    timeoutMs,
  });

  const result = await promise;
  const durationMs = Date.now() - startMs;
  return { stepId: step.id, result, durationMs };
}

// --- Workflow execution ---

interface StepLogEntry {
  id: string;
  status: "ok" | "error";
  durationMs: number;
  error?: string;
}

export async function executeWorkflow(workflowId: string): Promise<void> {
  const workflow = getWorkflow(workflowId);
  if (!workflow) {
    console.error(`[Workflow] Not found: ${workflowId}`);
    return;
  }

  if (!workflow.enabled) {
    console.log(`[Workflow] Skipped (disabled): ${workflowId}`);
    return;
  }

  const startMs = Date.now();
  const results = new Map<string, ClaudeResult>();
  const completed = new Set<string>();
  const failed = new Set<string>();
  const stepLogs: StepLogEntry[] = [];
  const stepMap = new Map(workflow.steps.map((s) => [s.id, s]));

  // Notify start
  if (sendCallback) {
    await sendCallback(
      workflow.channelType,
      workflow.chatId,
      `[Workflow] Starting "${workflow.name}" (${workflow.steps.length} steps)`,
    );
  }

  try {
    const batches = resolveExecutionOrder(workflow.steps);

    for (const batch of batches) {
      // Check if any dependency failed (skip this batch)
      const skipped = batch.filter((id) => {
        const step = stepMap.get(id)!;
        return (step.dependsOn ?? []).some((dep) => failed.has(dep));
      });

      const runnable = batch.filter((id) => !skipped.includes(id));

      // Mark skipped steps
      for (const id of skipped) {
        failed.add(id);
        stepLogs.push({ id, status: "error", durationMs: 0, error: "Skipped (dependency failed)" });
      }

      if (runnable.length === 0) continue;

      // Execute batch (all steps in parallel)
      const promises = runnable.map((id) =>
        executeStep(stepMap.get(id)!, workflow, results),
      );

      const batchResults = await Promise.all(promises);

      for (const { stepId, result, durationMs } of batchResults) {
        results.set(stepId, result);
        if (result.error) {
          failed.add(stepId);
          stepLogs.push({ id: stepId, status: "error", durationMs, error: result.error });
        } else {
          completed.add(stepId);
          stepLogs.push({ id: stepId, status: "ok", durationMs });
        }
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Workflow] Error in "${workflow.name}":`, errorMsg);
  }

  const totalDurationMs = Date.now() - startMs;

  // Determine overall status
  let status: "ok" | "error" | "partial";
  if (failed.size === 0) {
    status = "ok";
  } else if (completed.size === 0) {
    status = "error";
  } else {
    status = "partial";
  }

  // Update workflow state
  const state: WorkflowRunState = {
    lastRunAtMs: startMs,
    lastStatus: status,
    lastDurationMs: totalDurationMs,
    completedSteps: [...completed],
    failedStep: failed.size > 0 ? [...failed][0] : undefined,
    lastError: failed.size > 0
      ? stepLogs.find((l) => l.status === "error")?.error
      : undefined,
  };

  const workflows = loadWorkflows();
  const wf = workflows.find((w) => w.id === workflowId);
  if (wf) {
    wf.state = state;
    saveWorkflow(wf);
  }

  // Write JSONL run log
  appendRunLog(workflowId, {
    ts: startMs,
    workflowId,
    status,
    durationMs: totalDurationMs,
    steps: stepLogs,
  });

  // Report results to channel
  if (sendCallback) {
    const report = formatWorkflowReport(workflow.name, status, stepLogs, totalDurationMs, results);
    await sendCallback(workflow.channelType, workflow.chatId, report);
  }
}

// --- Reporting ---

function formatWorkflowReport(
  name: string,
  status: string,
  stepLogs: StepLogEntry[],
  totalDurationMs: number,
  results: Map<string, ClaudeResult>,
): string {
  const lines: string[] = [];
  lines.push(`[Workflow] "${name}" ${status} (${(totalDurationMs / 1000).toFixed(1)}s)`);

  for (const log of stepLogs) {
    const icon = log.status === "ok" ? "OK" : "FAIL";
    lines.push(`  ${icon} ${log.id} (${(log.durationMs / 1000).toFixed(1)}s)${log.error ? ` — ${log.error}` : ""}`);
  }

  // Include last step's output as summary (truncated)
  const lastOk = [...stepLogs].reverse().find((l) => l.status === "ok");
  if (lastOk) {
    const output = results.get(lastOk.id)?.output;
    if (output) {
      const truncated = output.length > 500 ? output.slice(0, 500) + "..." : output;
      lines.push("");
      lines.push(`Last output (${lastOk.id}):`);
      lines.push(truncated);
    }
  }

  return lines.join("\n");
}

// --- JSONL run logs ---

interface WorkflowRunLogEntry {
  ts: number;
  workflowId: string;
  status: "ok" | "error" | "partial";
  durationMs: number;
  steps: StepLogEntry[];
}

function appendRunLog(workflowId: string, entry: WorkflowRunLogEntry): void {
  const filePath = resolve(RUNS_DIR, `${workflowId}.jsonl`);
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /mnt/c/Users/kyjs0/Documents/Work/AI_Platform/Kkabi_c && npx vitest run src/workflow/engine.test.ts`
Expected: PASS (all 5 tests for resolveExecutionOrder)

**Step 5: Run full typecheck**

Run: `cd /mnt/c/Users/kyjs0/Documents/Work/AI_Platform/Kkabi_c && npx tsc --noEmit`
Expected: PASS

**Step 6: Commit**

```bash
git add src/workflow/engine.ts src/workflow/engine.test.ts
git commit -m "feat: add workflow engine with dependency resolution and step execution"
```

---

### Task 4: Workflow Commands

**Files:**
- Modify: `src/core/commands.ts`

**Step 1: Add workflow imports and command case**

Add import at top of `src/core/commands.ts`:

```typescript
import {
  loadWorkflows,
  getWorkflow,
  saveWorkflow,
  removeWorkflow,
  toggleWorkflow,
  reloadWorkflows,
} from "../workflow/store.js";
import { executeWorkflow } from "../workflow/engine.js";
```

Add case in the switch statement (after `case "agent":`):

```typescript
    case "workflow":
      return cmdWorkflow(args, chatId, channel);
```

**Step 2: Implement cmdWorkflow function**

Add before the `// --- Utilities ---` section:

```typescript
// --- !workflow ---

function cmdWorkflow(args: string, chatId: string, channel: ChannelType): CommandResult {
  if (!args) {
    const workflows = loadWorkflows();
    if (workflows.length === 0) return { text: "No workflows configured." };
    const lines = workflows.map((w) => {
      const status = w.enabled ? "ON" : "OFF";
      const lastStatus = w.state?.lastStatus ?? "-";
      const stepCount = w.steps.length;
      return `${status} [${w.id}] ${w.name} (${stepCount} steps) | ${lastStatus}`;
    });
    return { text: lines.join("\n") };
  }

  const parts = args.split(" ");
  const sub = parts[0];

  switch (sub) {
    case "show": {
      const id = parts[1];
      if (!id) return { text: "Usage: !workflow show <id>" };
      return cmdWorkflowShow(id);
    }
    case "run": {
      const id = parts[1];
      if (!id) return { text: "Usage: !workflow run <id>" };
      const wf = getWorkflow(id);
      if (!wf) return { text: `Workflow not found: ${id}` };
      executeWorkflow(id).catch((err) =>
        console.error(`[Workflow] Manual run error (${id}):`, err),
      );
      return { text: `Workflow "${wf.name}" started.` };
    }
    case "add": {
      const match = args.match(/add\s+(\S+)\s+"([^"]+)"/);
      if (!match) return { text: 'Usage: !workflow add <id> "<name>"' };
      const [, id, name] = match;
      if (getWorkflow(id)) return { text: `Workflow "${id}" already exists.` };
      saveWorkflow({
        id,
        name,
        enabled: true,
        steps: [],
        channelType: channel,
        chatId,
      });
      return { text: `Workflow created: ${id}. Edit data/workflows.json to add steps.` };
    }
    case "remove": {
      const id = parts[1];
      if (!id) return { text: "Usage: !workflow remove <id>" };
      return removeWorkflow(id)
        ? { text: `Workflow removed: ${id}` }
        : { text: `Workflow not found: ${id}` };
    }
    case "toggle": {
      const id = parts[1];
      if (!id) return { text: "Usage: !workflow toggle <id>" };
      const toggled = toggleWorkflow(id);
      return toggled
        ? { text: `Workflow ${toggled.enabled ? "enabled" : "disabled"}: ${id}` }
        : { text: `Workflow not found: ${id}` };
    }
    case "status": {
      const id = parts[1];
      return cmdWorkflowStatus(id);
    }
    case "reload": {
      const workflows = reloadWorkflows();
      return { text: `Workflows reloaded. ${workflows.length} workflow(s).` };
    }
    default:
      return { text: "Usage: !workflow <show|run|add|remove|toggle|status|reload>" };
  }
}

function cmdWorkflowShow(id: string): CommandResult {
  const wf = getWorkflow(id);
  if (!wf) return { text: `Workflow not found: ${id}` };

  const lines = [
    `Workflow: ${wf.name} (${wf.enabled ? "enabled" : "disabled"})`,
    `  ID: ${wf.id}`,
    `  Channel: ${wf.channelType} | ${wf.chatId}`,
    `  Steps:`,
  ];
  for (const step of wf.steps) {
    const deps = step.dependsOn?.length ? ` (after: ${step.dependsOn.join(", ")})` : "";
    lines.push(`    ${step.id}: agent=${step.agentId}${deps}`);
  }
  if (wf.state?.lastStatus) {
    lines.push(`  Last run: ${wf.state.lastStatus} (${new Date(wf.state.lastRunAtMs!).toISOString()})`);
  }
  return { text: lines.join("\n") };
}

function cmdWorkflowStatus(id?: string): CommandResult {
  if (!id) {
    const workflows = loadWorkflows();
    if (workflows.length === 0) return { text: "No workflows configured." };
    const lines: string[] = [];
    for (const wf of workflows) {
      const status = wf.enabled ? "ON" : "OFF";
      const lastRun = wf.state?.lastRunAtMs ? new Date(wf.state.lastRunAtMs).toISOString() : "never";
      const duration = wf.state?.lastDurationMs != null ? `${(wf.state.lastDurationMs / 1000).toFixed(1)}s` : "-";
      const lastStatus = wf.state?.lastStatus ?? "-";
      lines.push(`${status} [${wf.id}] ${wf.name}`);
      lines.push(`  ${lastStatus} | last: ${lastRun} | ${duration}`);
      if (wf.state?.lastError) {
        lines.push(`  error: ${wf.state.lastError.slice(0, 100)}`);
      }
    }
    return { text: lines.join("\n") };
  }

  const wf = getWorkflow(id);
  if (!wf) return { text: `Workflow not found: ${id}` };

  const lastRun = wf.state?.lastRunAtMs ? new Date(wf.state.lastRunAtMs).toISOString() : "never";
  const duration = wf.state?.lastDurationMs != null ? `${(wf.state.lastDurationMs / 1000).toFixed(1)}s` : "-";

  const lines = [
    `Workflow: ${wf.name} (${wf.enabled ? "enabled" : "disabled"})`,
    `  ID: ${wf.id}`,
    `  Status: ${wf.state?.lastStatus ?? "-"}`,
    `  Last run: ${lastRun}`,
    `  Duration: ${duration}`,
    `  Completed steps: ${wf.state?.completedSteps?.join(", ") ?? "-"}`,
  ];
  if (wf.state?.failedStep) lines.push(`  Failed step: ${wf.state.failedStep}`);
  if (wf.state?.lastError) lines.push(`  Last error: ${wf.state.lastError}`);
  return { text: lines.join("\n") };
}
```

**Step 3: Update HELP_TEXT**

Add workflow commands to the help text string:

```
!workflow           List workflows
!workflow show <id> Show workflow details
!workflow run <id>  Run a workflow
!workflow add <id> "<name>"  Create workflow
!workflow remove <id>  Remove workflow
!workflow toggle <id>  Enable/disable workflow
!workflow status [id]  Show workflow status
!workflow reload    Reload workflows from file
```

**Step 4: Run typecheck**

Run: `cd /mnt/c/Users/kyjs0/Documents/Work/AI_Platform/Kkabi_c && npx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/commands.ts
git commit -m "feat: add !workflow commands (show, run, add, remove, toggle, status, reload)"
```

---

### Task 5: Cron Integration

**Files:**
- Modify: `src/scheduler/cron.ts`

**Step 1: Add workflow import and update executeCronJob**

Add import at top:

```typescript
import { executeWorkflow } from "../workflow/engine.js";
```

**Step 2: Update executeCronJob to handle workflowId**

At the beginning of `executeCronJob`, before the existing prompt resolution logic, add:

```typescript
  // If this cron triggers a workflow, delegate to workflow engine
  if (job.workflowId) {
    const startMs = Date.now();
    try {
      await executeWorkflow(job.workflowId);
      updateJobState(job.id, {
        lastRunAtMs: startMs,
        lastStatus: "ok",
        lastDurationMs: Date.now() - startMs,
        consecutiveErrors: 0,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const newConsecutiveErrors = (job.state?.consecutiveErrors ?? 0) + 1;
      updateJobState(job.id, {
        lastRunAtMs: startMs,
        lastStatus: "error",
        lastDurationMs: Date.now() - startMs,
        consecutiveErrors: newConsecutiveErrors,
        lastError: errorMsg,
      });
      if (newConsecutiveErrors === ERROR_ALERT_THRESHOLD && sendCallback) {
        await sendCallback(
          job.channelType,
          job.chatId,
          `[Cron Alert] Workflow "${job.workflowId}" has failed ${ERROR_ALERT_THRESHOLD} times. Error: ${errorMsg}`,
        );
      }
    }
    return;
  }
```

**Step 3: Update !cron add to support --workflow flag**

In `commands.ts`, update the cron add case to parse `--workflow`:

```typescript
    case "add": {
      const match = args.match(/add\s+"([^"]+)"\s+"([^"]+)"/);
      if (!match) return { text: 'Usage: !cron add "<schedule>" "<prompt>" [--agent <id>] [--workflow <id>]' };
      const rest = args.slice(match[0].length);
      const agentId = rest.match(/--agent\s+(\S+)/)?.[1];
      const workflowId = rest.match(/--workflow\s+(\S+)/)?.[1];
      if (agentId && !getAgent(agentId)) {
        return { text: `Agent "${agentId}" not found.` };
      }
      if (workflowId && !getWorkflow(workflowId)) {
        return { text: `Workflow "${workflowId}" not found.` };
      }
      const job = addCron(match[1], match[2], channel, chatId, agentId, workflowId);
      const tags = [agentId && `agent: ${agentId}`, workflowId && `workflow: ${workflowId}`].filter(Boolean);
      const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
      return { text: `Cron job added: ${job.id.slice(0, 8)} (${match[1]})${tagStr}` };
    }
```

**Step 4: Update addCron signature in cron.ts**

Add `workflowId` parameter:

```typescript
export function addCron(
  schedule: string,
  prompt: string,
  channelType: ChannelType,
  chatId: string,
  agentId?: string,
  workflowId?: string,
): CronJob {
```

And include it in the job object:

```typescript
    ...(agentId ? { agentId } : {}),
    ...(workflowId ? { workflowId } : {}),
```

**Step 5: Run typecheck**

Run: `cd /mnt/c/Users/kyjs0/Documents/Work/AI_Platform/Kkabi_c && npx tsc --noEmit`
Expected: PASS

**Step 6: Commit**

```bash
git add src/scheduler/cron.ts src/core/commands.ts
git commit -m "feat: integrate workflows with cron (workflowId trigger)"
```

---

### Task 6: Context Integration

**Files:**
- Modify: `src/claude/context.ts`

**Step 1: Add workflow import**

```typescript
import { loadWorkflows } from "../workflow/store.js";
```

**Step 2: Add workflow info to buildCapabilitiesSection**

After the "Available Agents" block (around line 119), add:

```typescript
  // Available workflows
  const workflows = loadWorkflows();
  if (workflows.length > 0) {
    lines.push("## Available Workflows");
    lines.push("To trigger a workflow run, include this tag:");
    lines.push('  <!--WORKFLOW_RUN:{"id":"<workflow id>"}-->');
    for (const wf of workflows) {
      const stepNames = wf.steps.map((s) => s.id).join(" → ");
      lines.push(`- ${wf.id}: ${wf.name} (${stepNames})`);
    }
    lines.push("");
  }
```

**Step 3: Run typecheck**

Run: `cd /mnt/c/Users/kyjs0/Documents/Work/AI_Platform/Kkabi_c && npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/claude/context.ts
git commit -m "feat: add workflow info and WORKFLOW_RUN tag to prompt context"
```

---

### Task 7: Workflow Tag Parser

**Files:**
- Modify: `src/core/cronParser.ts`
- Modify: `src/core/cronExecutor.ts`
- Modify: `src/core/handler.ts`

**Step 1: Add workflow action to cronParser.ts**

Rename file concept: the parser now handles workflow tags too. Add to the `CronAction` union type:

```typescript
export type CronAction =
  | { type: "add"; schedule: string; prompt: string; agentId?: string }
  | { type: "remove"; id: string }
  | { type: "list" }
  | { type: "workflow_run"; id: string };
```

Add regex and parsing in `parseCronTags`:

```typescript
const WORKFLOW_RUN_RE = /<!--WORKFLOW_RUN:(.*?)-->/g;
```

Add parsing block:

```typescript
  // Parse workflow run actions
  for (const match of response.matchAll(WORKFLOW_RUN_RE)) {
    try {
      const payload = JSON.parse(match[1]) as { id: string };
      if (payload.id) {
        actions.push({ type: "workflow_run", id: payload.id });
      }
    } catch {
      // Skip malformed tags
    }
  }
```

Add to the strip section:

```typescript
    .replace(WORKFLOW_RUN_RE, "")
```

**Step 2: Handle workflow_run action in cronExecutor.ts**

Add import:

```typescript
import { executeWorkflow } from "../workflow/engine.js";
import { getWorkflow } from "../workflow/store.js";
```

Add case in the switch:

```typescript
      case "workflow_run": {
        const wf = getWorkflow(action.id);
        if (!wf) {
          results.push({ success: false, message: `Workflow not found: ${action.id}` });
        } else {
          executeWorkflow(action.id).catch((err) =>
            console.error(`[Workflow] Tag-triggered run error (${action.id}):`, err),
          );
          results.push({ success: true, message: `Workflow "${wf.name}" started.` });
        }
        break;
      }
```

**Step 3: Run typecheck**

Run: `cd /mnt/c/Users/kyjs0/Documents/Work/AI_Platform/Kkabi_c && npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/core/cronParser.ts src/core/cronExecutor.ts
git commit -m "feat: add WORKFLOW_RUN tag parsing and execution"
```

---

### Task 8: Lifecycle Integration

**Files:**
- Modify: `src/index.ts`

**Step 1: Add workflow send callback setup**

Add import:

```typescript
import { setWorkflowSendCallback } from "./workflow/engine.js";
```

After the existing `setCronSendCallback(...)` call (line 53), add:

```typescript
  setWorkflowSendCallback(async (channelType: ChannelType, chatId: string, text: string) => {
    const ch = channels.get(channelType);
    if (ch) {
      await ch.sendText(chatId, text);
    }
  });
```

**Step 2: Run typecheck**

Run: `cd /mnt/c/Users/kyjs0/Documents/Work/AI_Platform/Kkabi_c && npx tsc --noEmit`
Expected: PASS

**Step 3: Run all tests**

Run: `cd /mnt/c/Users/kyjs0/Documents/Work/AI_Platform/Kkabi_c && npx vitest run`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire workflow send callback in app lifecycle"
```

---

### Task 9: Final Verification

**Step 1: Run full test suite**

Run: `cd /mnt/c/Users/kyjs0/Documents/Work/AI_Platform/Kkabi_c && npx vitest run`
Expected: ALL PASS

**Step 2: Run typecheck**

Run: `cd /mnt/c/Users/kyjs0/Documents/Work/AI_Platform/Kkabi_c && npx tsc --noEmit`
Expected: PASS

**Step 3: Verify all new files exist**

```bash
ls -la src/workflow/store.ts src/workflow/store.test.ts src/workflow/engine.ts src/workflow/engine.test.ts
```

**Step 4: Final commit (if any unstaged changes)**

```bash
git status
```
