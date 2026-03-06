# Workflow Engine Design

## Overview

A general-purpose sub-agent framework for Kkabi_c that enables multi-step workflows where agents execute in sequence or parallel, passing context between steps.

**Core concept**: Workflows compose existing Agents into pipelines. Each step runs a Claude Code subprocess with the agent's persona and step-specific prompt. Previous step outputs are injected into subsequent prompts.

## Architecture

```
                    Trigger
                  (command / cron)
                       │
                       ▼
              ┌─────────────────┐
              │ Workflow Engine  │
              │  (orchestrator)  │
              └────────┬────────┘
                       │ reads workflows.json
                       │ resolves steps & dependencies
                       ▼
              ┌─────────────────┐
              │  Step Executor   │
              │ (serial/parallel)│
              └────────┬────────┘
                       │ for each step:
                       │ 1. resolve agent (persona, model, dir)
                       │ 2. build prompt (step prompt + prev output)
                       │ 3. enqueue to Claude queue
                       ▼
              ┌─────────────────┐
              │  Claude Queue    │  ← existing system
              │  (runner.ts)     │
              └────────┬────────┘
                       │
                       ▼
              ┌─────────────────┐
              │  Report results  │
              │  (via channel)   │
              └─────────────────┘
```

## Data Model

### New Types (`src/types.ts`)

```typescript
interface WorkflowStep {
  id: string;              // Step identifier (e.g. "plan", "develop")
  agentId: string;         // Agent reference from agents.json
  prompt: string;          // Step-specific prompt
  promptPath?: string;     // Or external prompt file
  dependsOn?: string[];    // Step IDs that must complete first
  timeoutMs?: number;      // Per-step timeout override
}

interface WorkflowRunState {
  lastRunAtMs?: number;
  lastStatus?: "ok" | "error" | "partial";
  lastDurationMs?: number;
  completedSteps?: string[];    // Which steps succeeded
  failedStep?: string;          // Which step failed (if any)
  lastError?: string;
}

interface Workflow {
  id: string;              // Workflow ID (e.g. "work_dev")
  name: string;            // Display name
  enabled: boolean;
  steps: WorkflowStep[];
  channelType: ChannelType;
  chatId: string;          // Result reporting destination
  state?: WorkflowRunState;
}
```

### Storage

- File: `data/workflows.json` (same pattern as crons.json, agents.json)
- Run logs: `data/workflow-runs/<workflow-id>.jsonl`

### Example workflow (`work_dev`)

```json
{
  "id": "work_dev",
  "name": "Plan → Develop Pipeline",
  "enabled": true,
  "steps": [
    {
      "id": "plan",
      "agentId": "planner",
      "prompt": "Read NEW_PLAN.md, pick a new feature, write design doc, update NEW_PLAN.md, git push."
    },
    {
      "id": "develop",
      "agentId": "developer",
      "prompt": "Read NEW_PLAN.md, implement oldest 'planned' feature, create PR, update status.",
      "dependsOn": ["plan"]
    }
  ],
  "channelType": "slack",
  "chatId": "C12345"
}
```

## Step Execution Logic

### Dependency Resolution

Steps without `dependsOn` (or empty array) can run immediately. Steps with `dependsOn` wait until all listed steps complete successfully.

```
Given steps: A (no deps), B (no deps), C (depends on A, B)

Execution:
  1. A and B start in parallel (if maxConcurrent allows, otherwise serial)
  2. When both A and B complete → C starts
  3. If A or B fails → C is skipped, workflow reports partial failure
```

### Context Passing

When a step has `dependsOn`, the outputs of those steps are prepended to its prompt:

```
[PREVIOUS STEP: plan]
<output of plan step>

[STEP PROMPT]
<this step's own prompt>
```

This gives each step awareness of what happened before, without requiring file-based coordination (though agents can still use files freely via their workingDir).

### Execution Flow (pseudocode)

```typescript
async function executeWorkflow(workflow: Workflow): Promise<void> {
  const results: Map<string, ClaudeResult> = new Map();
  const completed: Set<string> = new Set();
  const failed: Set<string> = new Set();

  while (completed.size + failed.size < workflow.steps.length) {
    // Find runnable steps: all dependencies met, not yet started
    const runnable = workflow.steps.filter(step =>
      !completed.has(step.id) &&
      !failed.has(step.id) &&
      (step.dependsOn ?? []).every(dep => completed.has(dep))
    );

    if (runnable.length === 0) break; // deadlock or all done

    // Execute runnable steps (enqueue all, await all)
    const promises = runnable.map(step => executeStep(step, workflow, results));
    const stepResults = await Promise.all(promises);

    for (const { stepId, result } of stepResults) {
      results.set(stepId, result);
      if (result.error) {
        failed.add(stepId);
      } else {
        completed.add(stepId);
      }
    }

    // If any step failed, skip dependents
    if (failed.size > 0) break;
  }

  // Report results to channel
  await reportWorkflowResult(workflow, results, completed, failed);
}
```

## New Files

| File | Purpose |
|------|---------|
| `src/workflow/store.ts` | CRUD for workflows.json (same pattern as agents/store.ts) |
| `src/workflow/engine.ts` | Workflow execution engine (step resolution, context passing, reporting) |

## Command Interface

### `!workflow` commands

```
!workflow                          List all workflows
!workflow show <id>                Show workflow details
!workflow run <id>                 Manually trigger a workflow
!workflow add <id> "<name>"        Create empty workflow (then edit JSON for steps)
!workflow remove <id>              Remove a workflow
!workflow toggle <id>              Enable/disable
!workflow status [id]              Show run state
!workflow reload                   Reload from file
```

### Cron Integration

Cron jobs get a new optional field `workflowId` (mutually exclusive with `prompt`/`agentId`):

```json
{
  "id": "...",
  "schedule": "0 9 * * 1-5",
  "workflowId": "work_dev",
  "channelType": "slack",
  "chatId": "C12345"
}
```

When a cron job has `workflowId`, it triggers `executeWorkflow()` instead of a single Claude run.

## Context Integration

`buildPrompt()` in `context.ts` gets an additional section listing available workflows (similar to how agents are listed in capabilities):

```
## Available Workflows
- work_dev: Plan → Develop Pipeline (2 steps)
```

And a new hidden tag format for natural language workflow creation:

```
<!--WORKFLOW_RUN:{"id":"work_dev"}-->
```

## State & Logging

### State tracking (in workflows.json)

Each workflow tracks its last run state, same pattern as CronJobState:

```typescript
{
  lastRunAtMs: 1709424000000,
  lastStatus: "ok",          // "ok" | "error" | "partial"
  lastDurationMs: 180000,
  completedSteps: ["plan", "develop"],
  failedStep: undefined,
  lastError: undefined
}
```

### JSONL run logs

Each run appends to `data/workflow-runs/<workflow-id>.jsonl`:

```json
{
  "ts": 1709424000000,
  "workflowId": "work_dev",
  "status": "ok",
  "durationMs": 180000,
  "steps": [
    { "id": "plan", "status": "ok", "durationMs": 60000 },
    { "id": "develop", "status": "ok", "durationMs": 120000 }
  ]
}
```

## Error Handling

1. **Step failure** → skip all dependent steps, mark workflow as "partial" or "error"
2. **Step timeout** → treat as failure, same behavior
3. **Report to channel** → always report, including which steps succeeded/failed
4. **No retry** — failed steps are not retried automatically (user can re-run manually)

## Lifecycle Integration

- `startAllWorkflows()` — no-op at startup (workflows are triggered, not always-running)
- Graceful shutdown — if a workflow is mid-execution, the underlying Claude process is cancelled via existing `cancelCurrent()`
- `reloadWorkflows()` — re-read workflows.json, invalidate cache

## Scope Boundaries (NOT included)

- No conditional branching (if/else in workflow definition) — Claude handles logic within each step
- No loop/retry in workflow definition
- No cross-workflow dependencies
- No workflow versioning
- No approval gates between steps (can be added later)
