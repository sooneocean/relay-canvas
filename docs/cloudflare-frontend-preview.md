# ReachFlow Cloudflare Frontend Preview

This branch is intended for a **separate, public, unindexed preview project** on Cloudflare Pages.
It is stacked on the unmerged Learning Engine v0.3 PR. Do not merge or deploy as the full app.

Build settings: Node.js 22; `npm ci`; `npm run build`; output directory `dist`.

## Scope
- Serve the real React/Vite frontend and shipped Demo board assets.
- The frontend will show **OFFLINE** because the source Express server only listens on
  `127.0.0.1` and no authenticated backend is deployed here.
- You can explore/edit demo nodes in memory. Saving, production generation, real
  media workflows, Agent execution, sharing and feedback persistence are **not available**.
- The page carries a non-dismissed preview limitation notice and noindex directives.
- No secrets, API keys, provider configuration, user data or real project assets are included.
- No Cloudflare D1, R2 or Worker secrets are provisioned.

## Going beyond frontend-only
To provide a functional cloud application, build a separate authenticated Cloudflare
Workers API with persistent storage (D1/Durable Objects + R2), audit the local-only
Express/MCP security model, and introduce user authentication/consent before enabling
remote AI generation. Do **not** expose the loopback session token or proxy it to a
public domain.

This preview is for interface review only, not end-to-end agent acceptance.
