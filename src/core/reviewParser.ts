export interface ReviewRequest {
  from?: string;  // optional — system fills in the sender identity
  workingDir: string;
  type: string;
  summary: string;
  files?: string[];
  branch?: string;
}

export interface ReviewParseResult {
  requests: ReviewRequest[];
  cleanedResponse: string;
}

const REVIEW_REQUEST_RE = /<!--REVIEW_REQUEST:([\s\S]*?)-->/g;

export function parseReviewTags(response: string): ReviewParseResult {
  const requests: ReviewRequest[] = [];

  for (const match of response.matchAll(REVIEW_REQUEST_RE)) {
    try {
      const payload = JSON.parse(match[1]) as ReviewRequest;
      if (payload.workingDir && payload.summary) {
        requests.push(payload);
      }
    } catch {
      // skip malformed tags
    }
  }

  const cleaned = response
    .replace(REVIEW_REQUEST_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { requests, cleanedResponse: cleaned };
}
