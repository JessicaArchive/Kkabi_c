# Agentic Coding Feature Design

## Goal

Enable Kkabi bot to perform code editing, git commits, branch management, and PR creation via Claude CLI, triggered from any channel (GitHub Issues, Slack, etc.).

## Architecture

### Current Flow
```
User message → Kkabi bot → claude -p "prompt" → text response → channel reply
```

### New Flow
```
User message → Kkabi bot → claude -p "prompt" --disallowedTools [blocked] →
  Claude edits code, commits, pushes branch, creates PR →
  text response + action summary → channel reply
```

## Config Changes

### Repository-to-directory mapping

`config.json` — `claude` section gets `projects` map and `disallowedTools` list:

```json
{
  "claude": {
    "workingDir": "~/default-project",
    "projects": {
      "mycompany/website": "/home/user/website",
      "mycompany/api": "/home/user/api"
    },
    "disallowedTools": [
      "Bash(git push --force*)",
      "Bash(git push origin main*)",
      "Bash(git branch -D*)",
      "Bash(gh pr merge*)"
    ]
  }
}
```

- `projects`: maps `owner/repo` to local clone path. Used by GitHub channel to resolve working directory per-issue.
- `disallowedTools`: passed to `claude -p --disallowedTools` to block dangerous git operations.
- For non-GitHub channels (Slack, etc.), `workingDir` is used as default.

### Repository config change

`channels.github.repositories` changes from `string[]` to `object[]`:

```json
{
  "channels": {
    "github": {
      "repositories": [
        { "name": "mycompany/website", "workingDir": "/home/user/website" },
        { "name": "mycompany/api", "workingDir": "/home/user/api" }
      ]
    }
  }
}
```

Each repository entry includes its local clone path.

## Code Changes

### 1. `src/config.ts` — Schema update

- Add `projects` (optional `Record<string, string>`) to `ClaudeConfigSchema`
- Add `disallowedTools` (optional `string[]`) to `ClaudeConfigSchema`
- Change `GitHubConfigSchema.repositories` from `z.array(z.string())` to `z.array()` accepting both string and object formats (backward compatible)

### 2. `src/claude/runner.ts` — Pass disallowedTools

- Read `config.claude.disallowedTools` and append `--disallowedTools` flag to `claude -p` args

### 3. `src/core/handler.ts` — Resolve workingDir per message

- For GitHub channel: extract repo from `chatId` (format: `owner/repo#123`), look up workingDir from config
- For other channels: use `config.claude.workingDir` (default)
- Pass resolved workingDir to `runClaude()`

### 4. `src/claude/context.ts` — Add coding instructions to prompt

Add a `[CODING RULES]` section to the prompt:
- Always create a new branch for changes (never commit directly to main)
- Use descriptive branch names (e.g., `feature/dark-mode-login`)
- Commit with clear messages
- Push branch and create PR when done
- Include a summary of changes in response

## Safety Layers

| Layer | Protection |
|-------|-----------|
| Input | Keyword scan + channel-specific approval (existing) |
| Tools | `--disallowedTools` blocks: force push, main push, branch delete, PR merge |
| Prompt | Instructions to always use branches, never push to main |
| GitHub | Branch protection rules on main (optional, external) |

## Blocked Operations

- `git push --force` (any branch)
- `git push origin main` (direct push to main)
- `git branch -D` (force delete branch)
- `gh pr merge` (auto-merge PR)

## Allowed Operations

Everything else, including:
- File read/edit/write
- Branch creation, checkout
- git add, commit
- Push to feature branches
- PR creation via `gh pr create`
- npm/yarn commands
- Web search/fetch
- Sub-agent spawning
