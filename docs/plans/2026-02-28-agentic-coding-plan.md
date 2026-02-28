# Agentic Coding Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable Kkabi bot to edit code, commit, push branches, and create PRs via Claude CLI, with dangerous operations blocked.

**Architecture:** Add `disallowedTools` and per-repo `workingDir` to config. Thread `workingDir` from handler through queue to runner. Add `--disallowedTools` flag to `claude -p` invocation. Add coding rules to prompt context.

**Tech Stack:** TypeScript, Zod (config validation), Node.js child_process (Claude CLI spawning)

---

### Task 1: Update config schema — add disallowedTools and projects

**Files:**
- Modify: `src/config.ts:27-31`

**Step 1: Add fields to ClaudeConfigSchema**

Replace lines 27-31 of `src/config.ts`:

```typescript
const ClaudeConfigSchema = z.object({
  timeoutMs: z.number().positive().default(300_000),
  maxConcurrent: z.number().positive().default(1),
  workingDir: z.string().default("~"),
  projects: z.record(z.string(), z.string()).default({}),
  disallowedTools: z.array(z.string()).default([]),
});
```

- `projects`: maps `"owner/repo"` to local clone absolute path (e.g. `{ "mycompany/website": "/home/user/website" }`)
- `disallowedTools`: list of tool patterns to block (e.g. `["Bash(git push --force*)"]`)

**Step 2: Verify typecheck passes**

Run: `cd /Users/yejiseulkim/Kkabi_c && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat: add projects and disallowedTools to claude config schema"
```

---

### Task 2: Update GitHub repositories config to support objects with workingDir

**Files:**
- Modify: `src/config.ts:12-20`
- Modify: `src/channels/github.ts:50,69-70`

**Step 1: Change GitHubConfigSchema repositories to accept objects**

Replace lines 12-20 of `src/config.ts`:

```typescript
const GitHubRepoSchema = z.union([
  z.string(),
  z.object({
    name: z.string().min(1),
    workingDir: z.string().optional(),
  }),
]);

const GitHubConfigSchema = z.object({
  enabled: z.boolean().default(false),
  appId: z.number(),
  installationId: z.number(),
  privateKeyPath: z.string().min(1),
  repositories: z.array(GitHubRepoSchema).min(1),
  pollIntervalMs: z.number().positive().default(30_000),
  label: z.string().optional(),
});
```

**Step 2: Add helper to extract repo name**

Add after the `GitHubConfigSchema` definition in `src/config.ts`:

```typescript
export function getRepoName(repo: string | { name: string; workingDir?: string }): string {
  return typeof repo === "string" ? repo : repo.name;
}

export function getRepoWorkingDir(repo: string | { name: string; workingDir?: string }): string | undefined {
  return typeof repo === "string" ? undefined : repo.workingDir;
}
```

**Step 3: Update github.ts to use helper**

In `src/channels/github.ts`, add import at top:

```typescript
import { getRepoName } from "../config.js";
```

Replace line 50 (`this.config.repositories.join`):

```typescript
`[GitHub] Polling ${this.config.repositories.map(r => getRepoName(r)).join(", ")} every ${this.config.pollIntervalMs}ms`,
```

Replace lines 69-70 (inside `poll()` method):

```typescript
for (const repoEntry of this.config.repositories) {
  const repoFullName = getRepoName(repoEntry);
  const [owner, repoName] = repoFullName.split("/");
```

**Step 4: Verify typecheck passes**

Run: `cd /Users/yejiseulkim/Kkabi_c && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/config.ts src/channels/github.ts
git commit -m "feat: support object format for GitHub repository config with workingDir"
```

---

### Task 3: Pass disallowedTools to claude -p in runner

**Files:**
- Modify: `src/claude/runner.ts:36`

**Step 1: Add disallowedTools to spawn args**

Replace line 36 of `src/claude/runner.ts`:

```typescript
    const args = ["-p", prompt, "--output-format", "text"];
    const disallowed = config.claude.disallowedTools;
    if (disallowed.length > 0) {
      args.push("--disallowedTools", disallowed.join(","));
    }
```

**Step 2: Verify typecheck passes**

Run: `cd /Users/yejiseulkim/Kkabi_c && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/claude/runner.ts
git commit -m "feat: pass --disallowedTools flag to claude CLI"
```

---

### Task 4: Thread workingDir through the queue

**Files:**
- Modify: `src/types.ts:44` (QueueItem)
- Modify: `src/claude/queue.ts:16-24,54`

**Step 1: Add workingDir to QueueItem type**

In `src/types.ts`, add `workingDir` to QueueItem (after line 45 `channel`):

```typescript
export interface QueueItem {
  id: string;
  prompt: string;
  chatId: string;
  channel: ChannelType;
  workingDir?: string;
  resolve: (result: ClaudeResult) => void;
  reject: (error: Error) => void;
}
```

**Step 2: Update enqueue() to accept and store workingDir**

Replace the `enqueue` function signature and body in `src/claude/queue.ts` (lines 16-34):

```typescript
export function enqueue(
  prompt: string,
  chatId: string,
  channel: ChannelType,
  workingDir?: string,
): { promise: Promise<ClaudeResult>; position: number; id: string } {
  const id = randomUUID();

  const promise = new Promise<ClaudeResult>((resolve, reject) => {
    queue.push({ id, prompt, chatId, channel, workingDir, resolve, reject });
  });

  const position = queue.length;

  if (!processing) {
    processNext();
  }

  return { promise, position, id };
}
```

**Step 3: Pass workingDir from queue to runClaude()**

Replace line 54 of `src/claude/queue.ts`:

```typescript
    const result = await runClaude(item.prompt, item.id, item.workingDir);
```

**Step 4: Verify typecheck passes**

Run: `cd /Users/yejiseulkim/Kkabi_c && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/types.ts src/claude/queue.ts
git commit -m "feat: thread workingDir through queue to Claude runner"
```

---

### Task 5: Resolve workingDir in handler based on chatId

**Files:**
- Modify: `src/core/handler.ts:4,67-68`

**Step 1: Add config import and workingDir resolver**

Add import at top of `src/core/handler.ts`:

```typescript
import { getConfig } from "../config.js";
```

Add helper function before `createHandler`:

```typescript
function resolveWorkingDir(chatId: string, channelType: string): string | undefined {
  const config = getConfig();
  // For GitHub channels, extract "owner/repo" from chatId format "owner/repo#123"
  if (channelType === "github") {
    const match = chatId.match(/^(.+?\/.+?)#\d+$/);
    if (match) {
      const repoName = match[1];
      // Check claude.projects map first
      if (config.claude.projects[repoName]) {
        return config.claude.projects[repoName];
      }
      // Check github repository config for workingDir
      const repoEntry = config.channels.github?.repositories.find((r) => {
        const name = typeof r === "string" ? r : r.name;
        return name === repoName;
      });
      if (repoEntry && typeof repoEntry === "object" && "workingDir" in repoEntry && repoEntry.workingDir) {
        return repoEntry.workingDir;
      }
    }
  }
  return undefined;
}
```

**Step 2: Pass workingDir to enqueue()**

Replace lines 67-68 of `src/core/handler.ts`:

```typescript
    const prompt = buildPrompt(text, chatId);
    const workingDir = resolveWorkingDir(chatId, msg.channel);
    const { promise, position } = enqueue(prompt, chatId, msg.channel, workingDir);
```

**Step 3: Verify typecheck passes**

Run: `cd /Users/yejiseulkim/Kkabi_c && npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/core/handler.ts
git commit -m "feat: resolve per-repo workingDir in message handler"
```

---

### Task 6: Add coding rules to Claude prompt context

**Files:**
- Modify: `src/claude/context.ts:6-7,21-22`

**Step 1: Add coding rules section to buildPrompt**

In `src/claude/context.ts`, add after line 22 (after the capabilities section push):

```typescript
  // Coding rules — instruct Claude on git workflow
  parts.push(buildCodingRulesSection());
```

**Step 2: Add buildCodingRulesSection function**

Add at the end of `src/claude/context.ts`:

```typescript
function buildCodingRulesSection(): string {
  const lines: string[] = ["[CODING RULES]"];
  lines.push("When the user asks you to modify code, fix bugs, or add features, follow these rules:");
  lines.push("");
  lines.push("## Git Workflow");
  lines.push("- ALWAYS create a new branch before making changes. Never commit directly to main/master.");
  lines.push("- Use descriptive branch names like: feature/<short-description>, fix/<short-description>");
  lines.push("- Write clear, concise commit messages that describe what changed and why.");
  lines.push("- After committing, push the branch and create a Pull Request using `gh pr create`.");
  lines.push("- NEVER force push. NEVER delete branches. NEVER merge PRs.");
  lines.push("");
  lines.push("## Response Format");
  lines.push("- After completing code changes, include a summary of what you did:");
  lines.push("  - Which files were modified/created");
  lines.push("  - What the changes do");
  lines.push("  - The PR link (if created)");
  return lines.join("\n");
}
```

**Step 3: Verify typecheck passes**

Run: `cd /Users/yejiseulkim/Kkabi_c && npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/claude/context.ts
git commit -m "feat: add coding rules section to Claude prompt context"
```

---

### Task 7: Update safety keywords for new git operations

**Files:**
- Modify: `src/config.ts:41-44`

**Step 1: Add git-related safety keywords**

Replace lines 41-44 of `src/config.ts`:

```typescript
  keywords: z.array(z.string()).default([
    "rm", "drop", "delete", "reset", "deploy", "push",
    "force", "merge", "rebase",
    "삭제", "제거", "초기화",
  ]),
```

This ensures that messages containing "force", "merge", or "rebase" trigger the approval flow.

**Step 2: Verify typecheck passes**

Run: `cd /Users/yejiseulkim/Kkabi_c && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat: add git safety keywords (force, merge, rebase)"
```

---

### Task 8: Verify everything works end-to-end

**Step 1: Run full typecheck**

Run: `cd /Users/yejiseulkim/Kkabi_c && npx tsc --noEmit`
Expected: No errors

**Step 2: Verify the app starts**

Run: `cd /Users/yejiseulkim/Kkabi_c && timeout 5 npx tsx src/index.ts 2>&1 || true`
Expected: Should start loading config (may fail if config.json is missing, that's OK — we're checking for import/syntax errors)

**Step 3: Update docs**

Update `docs/plans/2026-02-28-agentic-coding-design.md` with any changes made during implementation.
