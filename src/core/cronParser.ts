export type CronAction =
  | { type: "add"; schedule: string; prompt: string }
  | { type: "remove"; id: string }
  | { type: "list" };

export interface ParseResult {
  actions: CronAction[];
  cleanedResponse: string;
}

const CRON_JOB_RE = /<!--CRON_JOB:(.*?)-->/g;
const CRON_REMOVE_RE = /<!--CRON_REMOVE:(.*?)-->/g;
const CRON_LIST_RE = /<!--CRON_LIST-->/g;

export function parseCronTags(response: string): ParseResult {
  const actions: CronAction[] = [];

  // Parse add actions
  for (const match of response.matchAll(CRON_JOB_RE)) {
    try {
      const payload = JSON.parse(match[1]) as { schedule: string; prompt: string };
      if (payload.schedule && payload.prompt) {
        actions.push({ type: "add", schedule: payload.schedule, prompt: payload.prompt });
      }
    } catch {
      // Skip malformed tags
    }
  }

  // Parse remove actions
  for (const match of response.matchAll(CRON_REMOVE_RE)) {
    try {
      const payload = JSON.parse(match[1]) as { id: string };
      if (payload.id) {
        actions.push({ type: "remove", id: payload.id });
      }
    } catch {
      // Skip malformed tags
    }
  }

  // Parse list actions
  if (CRON_LIST_RE.test(response)) {
    actions.push({ type: "list" });
  }

  // Strip all tags and clean up extra blank lines
  let cleaned = response
    .replace(CRON_JOB_RE, "")
    .replace(CRON_REMOVE_RE, "")
    .replace(CRON_LIST_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { actions, cleanedResponse: cleaned };
}
