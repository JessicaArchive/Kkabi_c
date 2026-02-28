# Kkabi_c Setup Guide

## 1. Clone and Install

```bash
git clone <repo-url>
cd Kkabi_c
npm install
```

## 2. Create a GitHub App

1. Go to https://github.com/settings/apps/new (logged into your target account)
2. Fill in:
   - **App name**: any name (e.g., `kkabi-work`)
   - **Homepage URL**: anything
   - **Webhook Active**: **uncheck**
   - **Permissions** → Issues: **Read & Write**
3. Click **Create GitHub App**
4. Note the **App ID** shown on the app settings page
5. Click **Generate a private key** → download the `.pem` file → copy it to the project root

## 3. Install the GitHub App

1. App settings page → left menu → **Install App**
2. Click **Install** on your account/organization
3. Select **Only select repositories** → choose target repos → **Install**
4. Note the **Installation ID** from the URL after installation:
   ```
   https://github.com/settings/installations/XXXXXXX
                                               ^^^^^^^ this number
   ```

## 4. Create config.json

```json
{
  "channels": {
    "github": {
      "enabled": true,
      "appId": APP_ID_NUMBER,
      "installationId": INSTALLATION_ID_NUMBER,
      "privateKeyPath": "your-app.pem",
      "repositories": ["owner/repo"],
      "pollIntervalMs": 15000,
      "label": ""
    }
  }
}
```

Optional: add Slack channel

```json
{
  "channels": {
    "slack": {
      "enabled": true,
      "botToken": "xoxb-...",
      "appToken": "xapp-...",
      "allowedChannels": []
    },
    "github": { ... }
  }
}
```

## 5. Install Claude CLI

```bash
npm install -g @anthropic-ai/claude-code
claude  # authenticate on first run
```

## 6. Run

```bash
npm run dev    # development (watch mode)
npm start      # production
```

## Checklist

| # | Task | Done |
|---|------|------|
| 1 | `npm install` | |
| 2 | Create GitHub App (Webhook OFF, Issues R&W) | |
| 3 | Download private key → copy to project root | |
| 4 | Install the App on target repos | |
| 5 | Note App ID + Installation ID | |
| 6 | Create `config.json` | |
| 7 | Authenticate `claude` CLI | |
| 8 | `npm run dev` → confirm `Kkabi is ready!` in logs | |
