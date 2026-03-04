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
  steps: z.array(WorkflowStepSchema).min(0),
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
