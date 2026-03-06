# Kkabi_c

## Language

- All code, comments, commit messages, and user-facing strings must be written in English.
- Korean safety keywords in config (e.g. "삭제", "제거") are exceptions — they stay in Korean for detection purposes.

## Channels

- **Slack** — real-time via Socket Mode (`@slack/bolt`)
- **GitHub Issues** — polling-based via `octokit`. Issues are conversations (`chatId` = `"owner/repo#123"`). Safety confirmations use comment + reaction polling (thumbs up/down). Optionally filter issues by label.

## Routines

### work_dev
When asked to run "work_dev", execute the following steps sequentially in `C:/Users/kyjs0/Documents/Work/AI_Platform/playground-fc`:
1. Read `C:/Users/kyjs0/Documents/Work/AI_Platform/Kkabi_c/data/prompts/planner.md` and execute the planner routine
2. Read `C:/Users/kyjs0/Documents/Work/AI_Platform/Kkabi_c/data/prompts/developer.md` and execute the developer routine
