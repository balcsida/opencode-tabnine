# opencode-tabnine

OpenCode plugin that exposes Tabnine Agentic models as provider `tabnine`.

## Install And Login

From a checkout of this repository:

```bash
curl -fsSL https://opencode.ai/install | bash
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
node -e 'const fs=require("fs"),path=require("path"); const file=path.join(process.env.XDG_CONFIG_HOME||path.join(process.env.HOME,".config"),"opencode","opencode.json"); let config={}; try{config=JSON.parse(fs.readFileSync(file,"utf8"))}catch{} const plugin=`file://${process.cwd()}`; const plugins=Array.isArray(config.plugin)?config.plugin:[]; if(!plugins.some((entry)=>(Array.isArray(entry)?entry[0]:entry)===plugin)) plugins.push(plugin); config.plugin=plugins; fs.writeFileSync(file,`${JSON.stringify(config,null,2)}\n`)'
TABNINE_HOST=https://tabnine.example.com opencode auth login tabnine
```

Replace `https://tabnine.example.com` with your Tabnine tenant URL. Other official OpenCode install options include `npm i -g opencode-ai`, `bun add -g opencode-ai`, `brew install anomalyco/tap/opencode`, and `paru -S opencode`.

## Use Locally

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
bun test
bun run typecheck
```
