export interface CommitSuggestion {
  message: string;
}

export interface CommitParseResult {
  suggestions: CommitSuggestion[];
  cleanedResponse: string;
}

const COMMIT_SUGGEST_RE = /<!--COMMIT_SUGGEST:([\s\S]*?)-->/g;

export function parseCommitTags(response: string): CommitParseResult {
  const suggestions: CommitSuggestion[] = [];

  for (const match of response.matchAll(COMMIT_SUGGEST_RE)) {
    try {
      const payload = JSON.parse(match[1]) as CommitSuggestion;
      if (payload.message) {
        suggestions.push(payload);
      }
    } catch {
      // skip malformed tags
    }
  }

  const cleaned = response
    .replace(COMMIT_SUGGEST_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { suggestions, cleanedResponse: cleaned };
}
