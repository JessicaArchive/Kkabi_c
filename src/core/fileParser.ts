import { existsSync } from "node:fs";

export interface FileAction {
  path: string;
  caption?: string;
}

export interface FileParseResult {
  files: FileAction[];
  cleanedResponse: string;
}

const SEND_FILE_RE = /<!--SEND_FILE:(.*?)-->/g;

export function parseFileTags(response: string): FileParseResult {
  const files: FileAction[] = [];

  for (const match of response.matchAll(SEND_FILE_RE)) {
    try {
      const payload = JSON.parse(match[1]) as { path: string; caption?: string };
      if (payload.path) {
        const expanded = payload.path.replace(/^~/, process.env.HOME ?? "~");
        if (existsSync(expanded)) {
          files.push({ path: expanded, caption: payload.caption });
        }
      }
    } catch {
      // Skip malformed tags
    }
  }

  const cleaned = response
    .replace(SEND_FILE_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { files, cleanedResponse: cleaned };
}
