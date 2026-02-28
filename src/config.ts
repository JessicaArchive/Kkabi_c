import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const SlackConfigSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().min(1),
  appToken: z.string().min(1),
  allowedChannels: z.array(z.string()).default([]),
});

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

const ChannelsConfigSchema = z.object({
  slack: SlackConfigSchema.optional(),
  github: GitHubConfigSchema.optional(),
});

const ClaudeConfigSchema = z.object({
  timeoutMs: z.number().positive().default(300_000),
  maxConcurrent: z.number().positive().default(1),
  workingDir: z.string().default("~"),
  projects: z.record(z.string(), z.string()).default({}),
  disallowedTools: z.array(z.string()).default([]),
});

const MemoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  logRetentionDays: z.number().positive().default(30),
});

const SafetyConfigSchema = z.object({
  enabled: z.boolean().default(true),
  confirmTimeoutMs: z.number().positive().default(120_000),
  keywords: z.array(z.string()).default([
    "rm", "drop", "delete", "reset", "deploy", "push",
    "force", "merge", "rebase",
    "삭제", "제거", "초기화",
  ]),
});

const SchedulerConfigSchema = z.object({
  enabled: z.boolean().default(true),
});

const ConfigSchema = z.object({
  channels: ChannelsConfigSchema,
  claude: ClaudeConfigSchema.default({}),
  memory: MemoryConfigSchema.default({}),
  safety: SafetyConfigSchema.default({}),
  scheduler: SchedulerConfigSchema.default({}),
});

export type AppConfig = z.infer<typeof ConfigSchema>;
export type SlackConfig = z.infer<typeof SlackConfigSchema>;
export type GitHubConfig = z.infer<typeof GitHubConfigSchema>;
export type GitHubRepo = z.infer<typeof GitHubRepoSchema>;

export function getRepoName(repo: GitHubRepo): string {
  return typeof repo === "string" ? repo : repo.name;
}

let _config: AppConfig | null = null;

export function loadConfig(configPath?: string): AppConfig {
  const filePath = configPath ?? resolve(process.cwd(), "config.json");
  const raw = readFileSync(filePath, "utf-8");
  const json = JSON.parse(raw);
  _config = ConfigSchema.parse(json);
  return _config;
}

export function getConfig(): AppConfig {
  if (!_config) {
    throw new Error("Config not loaded. Call loadConfig() first.");
  }
  return _config;
}
