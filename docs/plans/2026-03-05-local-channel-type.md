# Local Channel Type Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add "local" channel type so cron/workflow jobs can run without external channels, outputting results to console + file.

**Architecture:** Add "local" to the `ChannelType` union. In `index.ts`, handle `channelType === "local"` in the cron/workflow send callbacks by logging to console and appending to a local output log file. No new Channel class needed.

**Tech Stack:** Node.js fs (appendFileSync), existing cron/workflow infrastructure.

---

### Task 1: Add "local" to ChannelType

**Files:**
- Modify: `src/types.ts:1`

**Step 1: Update ChannelType union**

Change:
```ts
export type ChannelType = "slack" | "github" | "gchat";
```
To:
```ts
export type ChannelType = "slack" | "github" | "gchat" | "local";
```

**Step 2: Run type check to verify no breakage**

Run: `npx tsc --noEmit`
Expected: PASS (no errors — "local" extends the union, existing code still valid)

**Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add 'local' to ChannelType union"
```

---

### Task 2: Handle "local" in send callbacks

**Files:**
- Modify: `src/index.ts:49-62`

**Step 1: Add localSend helper and use it in both callbacks**

Add before the cron send callback setup:

```ts
import { appendFileSync, mkdirSync } from "node:fs";

const LOCAL_OUTPUT_LOG = resolve(process.cwd(), "data", "local-output.log");

function localSend(text: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${text}`;
  console.log(line);
  mkdirSync(dirname(LOCAL_OUTPUT_LOG), { recursive: true });
  appendFileSync(LOCAL_OUTPUT_LOG, line + "\n", "utf-8");
}
```

Update cron send callback (line ~49):
```ts
setCronSendCallback(async (channelType: ChannelType, chatId: string, text: string) => {
  if (channelType === "local") {
    localSend(text);
    return;
  }
  const ch = channels.get(channelType);
  if (ch) {
    await ch.sendText(chatId, text);
  }
});
```

Update workflow send callback (line ~57):
```ts
setWorkflowSendCallback(async (channelType: ChannelType, chatId: string, text: string) => {
  if (channelType === "local") {
    localSend(text);
    return;
  }
  const ch = channels.get(channelType);
  if (ch) {
    await ch.sendText(chatId, text);
  }
});
```

**Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: handle 'local' channel in cron/workflow send callbacks"
```

---

### Task 3: Verify with manual test

**Step 1: Add a test cron job to `data/crons.json` with local channel**

Example entry:
```json
{
  "id": "test-local",
  "name": "local test",
  "schedule": "*/1 * * * *",
  "prompt": "Say hello",
  "channelType": "local",
  "chatId": "local",
  "enabled": true,
  "createdAt": 1741168800000,
  "updatedAt": 1741168800000
}
```

**Step 2: Start the bot and verify**

Run: `npm start`
Expected: After 1 minute, console shows `[Cron] local test` output and `data/local-output.log` has the entry.

**Step 3: Clean up test cron and commit if needed**

Remove test entry from `data/crons.json`.
