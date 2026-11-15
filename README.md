# Modrinth MCP connector

A Claude connector for managing your Modrinth projects, running as a free Cloudflare Worker.
Your Modrinth token goes **in the URL path**. Nothing is stored. The Worker reads the token on every request and only sends it to `api.modrinth.com`.

```
https://modrinth-mcp.<your-subdomain>.workers.dev/<your-modrinth-token>/mcp
```

## Tools

| Tool | What it does |
|---|---|
| `get_project` | Title, summary, review status, loaders, game versions, links, downloads, followers |
| `get_stats` | Total downloads and followers, plus downloads per version |
| `list_versions` | Every version with loaders, game versions, files and dependencies |
| `update_links` | Set the issue tracker, source, wiki and/or Discord links |
| `update_description` | Replace the markdown description and/or one-line summary |
| `upload_version` | Upload a jar as a new version, from a URL or base64. Supports `dry_run` |

`upload_version` reads the jar to fill everything in:

| Jar contains | Tagged as |
|---|---|
| `fabric.mod.json` | Fabric + Quilt, with Fabric API as a required dependency if the mod depends on it |
| `quilt.mod.json` | Quilt |
| `META-INF/neoforge.mods.toml` | NeoForge |
| `META-INF/mods.toml` | Forge |
| `plugin.yml` / `paper-plugin.yml` | Paper + Purpur (+ Folia if `folia-supported: true`) |

The Minecraft version comes from the jar (`~26.2`, `[26.2,26.3)`, `api-version: '26.2'`…) and is checked against Modrinth's list. The default version number is `<mod version>+<mc>-<loader>`, e.g. `1.2.0+26.3-neoforge`. A jar that's already on the project (same file hash or version number) is skipped.

## One-click deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/p1e2r/hmm)

Click the button and sign in to Cloudflare. It copies this repo to your GitHub account and deploys the Worker. Then do steps 1 and 3 below.

## Setup

1. **Make a Modrinth token.** Go to modrinth.com → Settings → Personal access tokens and give it these scopes:
   - Read projects
   - Write projects
   - Create versions
   - Read versions

2. **Deploy the Worker.** Use the button above, or do it by hand with Node.js and a free Cloudflare account:
   ```bash
   npm install
   npx wrangler login
   npx wrangler deploy
   ```
   Wrangler prints your URL, e.g. `https://modrinth-mcp.yourname.workers.dev`.

3. **Add it to Claude.** In Claude, go to Settings → Connectors → **Add custom connector**. Paste:
   ```
   https://modrinth-mcp.yourname.workers.dev/mrp_yourTokenHere/mcp
   ```
   Leave the OAuth fields empty.

## Security

- **The URL is a password.** Anyone with it can edit your Modrinth projects. Don't share it or post it anywhere.
- To cut off access, delete or regenerate the token on Modrinth. The old URL stops working immediately.
- Logging is turned off in `wrangler.jsonc` (`observability.enabled: false`), so request URLs aren't stored in Cloudflare's logs. Leave it off.
- Give the token a short expiry and only the scopes listed above.

## Local development

```bash
npm run dev     # http://127.0.0.1:8787/<token>/mcp
npm run check   # typecheck
```

## License

MIT
