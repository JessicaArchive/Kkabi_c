import {
  readFileSync,
  appendFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import type { Workflow, WorkflowStep, WorkflowRunState, ClaudeResult, ChannelType } from "../types.js";
import { getAgent } from "../agents/store.js";
import { getWorkflow, saveWorkflow } from "./store.js";
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

  const wf = getWorkflow(workflowId);
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
