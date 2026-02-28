# Kkabi_c

## Language

- All code, comments, commit messages, and user-facing strings must be written in English.
- Korean safety keywords in config (e.g. "삭제", "제거") are exceptions — they stay in Korean for detection purposes.

## Channels

- **Slack** — real-time via Socket Mode (`@slack/bolt`)
- **GitHub Issues** — polling-based via `octokit`. Issues are conversations (`chatId` = `"owner/repo#123"`). Safety confirmations use comment + reaction polling (thumbs up/down). Optionally filter issues by label.
