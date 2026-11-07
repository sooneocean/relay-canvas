# ReachFlow Cloudflare Frontend Preview — deployed

## Live preview

https://reachflow-canvas-preview.sooneocean.workers.dev/

- Platform: Cloudflare Worker `reachflow-canvas-preview` in the authenticated `sooneocean` account.
- Cloudflare API: script deployed, one deployment version at **100%**, workers.dev subdomain enabled.
- Browser validation: external HTTP probing was blocked by the verification environment, so direct browser loading remains unverified here.
- Public, unindexed UI-only preview. Does not implement a real cloud backend or persistence.

## Source and repeatable build

- `deploy/reachflow-cloudflare-frontend`: source preview branch, based on Learning Engine v0.3.
- `Build ReachFlow Cloudflare frontend preview`: GitHub Actions builds the Vite app (Node 22), then publishes only `dist` files to `deploy/reachflow-static-built`.
- Built public files: `index.html`, hashed Vite JS/CSS, favicon, Demo video, preview banner stylesheet and `_headers`.
- No Cloudflare credentials were placed into GitHub. Updating the build branch **does not auto-deploy the Worker**; the next release must be published separately.

## Deployment method and limitation

Cloudflare Pages Git integration failed with error `8000011` (Git installation authorization).
The temporary empty Pages project was cleaned up. A separate Worker was deployed
using the authenticated Cloudflare Worker Script Upload API with a self-contained
static preview bundle (roughly 1 MiB of built assets). This deliberately avoids
all production Express, MCP, user data, media inputs and provider credentials.

`GET /api/*` returns JSON 503 with `BACKEND_UNAVAILABLE`; `POST/PUT` operations
are rejected. The demo canvas can be explored in-memory. Save, generation, Agent,
feedback storage and remote media workflows are **not available**.

The Worker uses strict noindex/security headers and serves exact Vite build paths.
For a long-term public product, use Cloudflare Workers Static Assets, CI/CD Git
integration, authenticated APIs with D1/DO and R2, and replace local-only session
assumptions before enabling storage or paid generation.

## Future deployments

1. Build the intended source revision in GitHub Actions, verify `npm run build` and `dist`.
2. Review the compiled static files for secrets; never publish `.env`, `.relay-canvas`,
   `work`, server output, user projects or model keys.
3. Publish the new static assets to Cloudflare via the authenticated Worker upload API
   (Cloudflare Scripts Write). Do not commit the API token.
4. Confirm Cloudflare deployment version and workers.dev routing, then test homepage,
   hashed JS/CSS, Demo video, CSP and API 503 in an independent browser.

This is a UI preview, not proof the LangGraph or media backend works in Cloudflare.
