import { Octokit } from "octokit";
import type { Channel } from "./base.js";
import type { ChannelType, IncomingMessage } from "../types.js";
import type { GitHubConfig } from "../config.js";

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

  constructor(private config: GitHubConfig) {
    this.octokit = new Octokit({ auth: config.token });
  }

  async start(): Promise<void> {
    const { data } = await this.octokit.rest.users.getAuthenticated();
    this.botUsername = data.login;
    console.log(`[GitHub] Authenticated as @${this.botUsername}`);

    // Run first poll immediately, then on interval
    await this.poll();
    this.timer = setInterval(() => {
      this.poll().catch((err) => console.error("[GitHub] Poll error:", err));
    }, this.config.pollIntervalMs);

    console.log(
      `[GitHub] Polling ${this.config.repositories.join(", ")} every ${this.config.pollIntervalMs}ms`,
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
    const since = this.lastChecked;
    this.lastChecked = new Date().toISOString();

    for (const repo of this.config.repositories) {
      const [owner, repoName] = repo.split("/");
      await this.pollRepo(owner, repoName, since);
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

    for (const issue of issues) {
      // Skip pull requests (GitHub API returns PRs in issues endpoint)
      if (issue.pull_request) continue;

      const chatId = `${owner}/${repo}#${issue.number}`;

      // Check if the issue body itself is new (created since last poll)
      const createdAt = new Date(issue.created_at).toISOString();
      if (createdAt > since && issue.user?.login !== this.botUsername) {
        const incoming: IncomingMessage = {
          id: `issue-${issue.number}`,
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
        // Skip own comments
        if (comment.user?.login === this.botUsername) continue;

        // Skip comments that were created before our since window
        if (new Date(comment.created_at).toISOString() <= since) continue;

        const incoming: IncomingMessage = {
          id: `comment-${comment.id}`,
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
