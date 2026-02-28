import { Octokit } from "octokit";
import { createAppAuth } from "@octokit/auth-app";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Channel } from "./base.js";
import type { ChannelType, IncomingMessage } from "../types.js";
import { getRepoName, type GitHubConfig } from "../config.js";

const MAX_COMMENT_LENGTH = 65536;
const REACTION_POLL_INTERVAL_MS = 5_000;
const REACTION_TIMEOUT_MS = 120_000;

export class GitHubChannel implements Channel {
  readonly type: ChannelType = "github";
  private octokit: Octokit;
  private handler: ((msg: IncomingMessage) => Promise<void>) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private botUsername = "";
  private lastChecked = new Date().toISOString();
  private processedIds = new Set<string>();

  constructor(private config: GitHubConfig) {
    const privateKey = readFileSync(
      resolve(process.cwd(), config.privateKeyPath),
      "utf-8",
    );
    this.octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: config.appId,
        privateKey,
        installationId: config.installationId,
      },
    });
  }

  async start(): Promise<void> {
    // GitHub App bots have a login like "app-name[bot]"
    const { data: app } = await this.octokit.rest.apps.getAuthenticated() as { data: { slug?: string } | null };
    this.botUsername = `${app?.slug ?? "bot"}[bot]`;
    console.log(`[GitHub] Authenticated as ${this.botUsername}`);

    // Run first poll immediately, then on interval
    await this.poll();
    this.timer = setInterval(() => {
      this.poll().catch((err) => console.error("[GitHub] Poll error:", err));
    }, this.config.pollIntervalMs);

    console.log(
      `[GitHub] Polling ${this.config.repositories.map(r => getRepoName(r)).join(", ")} every ${this.config.pollIntervalMs}ms`,
    );
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log("[GitHub] Stopped polling");
  }

  private async poll(): Promise<void> {
    // Subtract 2 seconds to avoid missing issues due to millisecond precision mismatch
    const sinceDate = new Date(new Date(this.lastChecked).getTime() - 2000);
    const since = sinceDate.toISOString();
    this.lastChecked = new Date().toISOString();
    console.log(`[GitHub] Polling since ${since}`);

    for (const repoEntry of this.config.repositories) {
      const repo = getRepoName(repoEntry);
      const [owner, repoName] = repo.split("/");
      try {
        await this.pollRepo(owner, repoName, since);
      } catch (err) {
        console.error(`[GitHub] Error polling ${repo}:`, err);
      }
    }
  }

  private async pollRepo(owner: string, repo: string, since: string): Promise<void> {
    // Fetch open issues (optionally filtered by label)
    const params: Parameters<Octokit["rest"]["issues"]["listForRepo"]>[0] = {
      owner,
      repo,
      state: "open",
      since,
      sort: "updated",
      direction: "asc",
      per_page: 50,
    };
    if (this.config.label) {
      params.labels = this.config.label;
    }

    const { data: issues } = await this.octokit.rest.issues.listForRepo(params);
    console.log(`[GitHub] Found ${issues.length} issues in ${owner}/${repo}`);

    for (const issue of issues) {
      // Skip pull requests (GitHub API returns PRs in issues endpoint)
      if (issue.pull_request) continue;

      // Skip issues not assigned to this bot's configured assignee
      if (this.config.assignee) {
        const assignees = issue.assignees?.map((a) => a.login) ?? [];
        if (!assignees.includes(this.config.assignee)) continue;
      }

      const chatId = `${owner}/${repo}#${issue.number}`;

      // Check if the issue body itself is new (created since last poll)
      const createdAt = new Date(issue.created_at).toISOString();
      console.log(`[GitHub] Issue #${issue.number} "${issue.title}" created=${createdAt} since=${since} by=${issue.user?.login}`);
      const issueKey = `issue-${issue.number}`;
      if (issue.user?.login === this.botUsername) continue;
      if (createdAt >= since && !this.processedIds.has(issueKey)) {
        this.processedIds.add(issueKey);
        const incoming: IncomingMessage = {
          id: issueKey,
          channel: "github",
          chatId,
          senderId: issue.user?.login ?? "unknown",
          senderName: issue.user?.login ?? "unknown",
          text: `[Issue: ${issue.title}]\n\n${issue.body ?? ""}`,
          timestamp: new Date(issue.created_at).getTime(),
        };
        await this.dispatch(incoming);
      }

      // Fetch comments since last check
      const { data: comments } = await this.octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: issue.number,
        since,
        per_page: 100,
      });

      for (const comment of comments) {
        // Skip comments posted by this bot
        if (comment.user?.login === this.botUsername) continue;

        // Skip comments that were created before our since window
        if (new Date(comment.created_at).toISOString() < since) continue;

        const commentKey = `comment-${comment.id}`;
        if (this.processedIds.has(commentKey)) continue;
        this.processedIds.add(commentKey);

        const incoming: IncomingMessage = {
          id: commentKey,
          channel: "github",
          chatId,
          senderId: comment.user?.login ?? "unknown",
          senderName: comment.user?.login ?? "unknown",
          text: comment.body ?? "",
          timestamp: new Date(comment.created_at).getTime(),
        };
        await this.dispatch(incoming);
      }
    }
  }

  private async dispatch(msg: IncomingMessage): Promise<void> {
    if (!this.handler) return;
    try {
      await this.handler(msg);
    } catch (err) {
      console.error("[GitHub] Handler error:", err);
    }
  }

  async sendText(chatId: string, text: string, _threadId?: string): Promise<string> {
    const { owner, repo, issueNumber } = parseChatId(chatId);
    const truncated =
      text.length > MAX_COMMENT_LENGTH
        ? text.slice(0, MAX_COMMENT_LENGTH - 20) + "\n\n... (truncated)"
        : text;

    const { data } = await this.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: truncated,
    });

    return String(data.id);
  }

  async editMessage(chatId: string, msgId: string, text: string): Promise<void> {
    const { owner, repo } = parseChatId(chatId);
    const truncated =
      text.length > MAX_COMMENT_LENGTH
        ? text.slice(0, MAX_COMMENT_LENGTH - 20) + "\n\n... (truncated)"
        : text;

    try {
      await this.octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: Number(msgId),
        body: truncated,
      });
    } catch {
      // If edit fails, send new comment
      await this.sendText(chatId, text);
    }
  }

  async sendConfirm(chatId: string, text: string, _threadId?: string): Promise<boolean> {
    const { owner, repo } = parseChatId(chatId);
    const { data: comment } = await this.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: parseChatId(chatId).issueNumber,
      body: `${text}\n\n---\nReact with :+1: to approve or :-1: to deny.`,
    });

    // Poll for reactions
    const deadline = Date.now() + REACTION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(REACTION_POLL_INTERVAL_MS);

      const { data: reactions } = await this.octokit.rest.reactions.listForIssueComment({
        owner,
        repo,
        comment_id: comment.id,
        per_page: 100,
      });

      const hasApprove = reactions.some(
        (r) => r.content === "+1" && r.user?.login !== this.botUsername,
      );
      const hasDeny = reactions.some(
        (r) => r.content === "-1" && r.user?.login !== this.botUsername,
      );

      if (hasApprove) return true;
      if (hasDeny) return false;
    }

    // Timeout → deny
    await this.octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: comment.id,
      body: `${text}\n\n---\n~~React with :+1: to approve or :-1: to deny.~~\n**Timed out — auto-denied.**`,
    });
    return false;
  }

  async sendFile(chatId: string, filePath: string, _threadId?: string): Promise<void> {
    const fileName = filePath.split("/").pop() ?? "file";
    await this.sendText(
      chatId,
      `**File:** \`${fileName}\`\n\n> File upload is not supported on GitHub Issues. The file is located at: \`${filePath}\``,
    );
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler;
  }
}

function parseChatId(chatId: string): { owner: string; repo: string; issueNumber: number } {
  // chatId format: "owner/repo#123"
  const match = chatId.match(/^(.+?)\/(.+?)#(\d+)$/);
  if (!match) throw new Error(`Invalid GitHub chatId: ${chatId}`);
  return { owner: match[1], repo: match[2], issueNumber: Number(match[3]) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
