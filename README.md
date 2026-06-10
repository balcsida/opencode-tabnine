# opencode-provider-tabnine

OpenCode plugin that exposes Tabnine Agentic models as provider `tabnine`.

## Install

Install OpenCode, then install the provider plugin from npm:

```bash
opencode plugin -g opencode-provider-tabnine
TABNINE_HOST=https://tabnine.example.com opencode auth login tabnine
```

## Use From Source

Add the plugin to an OpenCode config:

```json
{
  "plugin": ["file:///absolute/path/to/opencode-tabnine"]
}
```

Then authenticate:

```bash
opencode auth login tabnine
```

Set `TABNINE_HOST` or make sure Tabnine CLI has `~/.tabnine/agent/settings.json` with `general.tabnineHost`. Use your Tabnine tenant URL:

```bash
export TABNINE_HOST=https://tabnine.example.com
```

Browser login starts a local callback server and opens Tabnine's custom-token login page. The plugin also honors `TABNINE_TOKEN`, `TABNINE_JWT`, and `TABNINE_REFRESH_TOKEN` for non-interactive configuration.

After the first login, restart OpenCode so the config hook can load the persisted Tabnine host and refresh token, then choose provider `tabnine`.

## Models

When credentials are available, the plugin calls `GET /chat/v2/models`, filters to models with the `agent` capability, and registers the live list. If discovery is unavailable, it falls back to the four Agentic model IDs documented for Tabnine CLI 0.16.3.

## Development

```bash
bun install
bun run check
bun run clean && bun run build
npm pack --dry-run
```
