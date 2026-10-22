# Implementation contract v1

Shared types live in src/shared/types.ts; relative TS imports use .js suffix. Node 22 ESM, strict TS.

## HTTP (all /api except session require token)

GET /api/session with X-Canvas-Client: ui and Origin equal server origin OR Sec-Fetch-Site:same-origin returns {token}. Every other /api request carries Origin and X-Canvas-Token (browser GET may omit Origin if Sec-Fetch-Site same-origin). Host must be exact. GET /healthz public minimal version only.

- GET /api/state -> AppState.
- POST /api/boards {name} -> Board (empty nodes/edges).
- PUT /api/boards/:id {expectedRevision,board} -> saved Board; revision increments. Strip React Flow transient fields when creating request.
- POST /api/boards/:id/patch {expectedRevision,operations:Operation[]} -> Board.
- POST /api/boards/:id/validate {nodeId?} -> ExecutionPlan.
- PUT /api/providers {providers:Provider[]} -> Provider[]. Never API key values.
- POST /api/runs {boardId,expectedRevision,operationId,nodeId?,confirmExternal?} -> Run, HTTP 202. Use crypto.randomUUID() per intentional click, reuse same id for request retries. Remote explicit confirmation and server enable required.
- GET /api/runs/:id -> Run.
- POST /api/runs/:id/cancel {} -> Run.
- Errors {error:string,code:string}, conflicts 409. Poll /api/state every 1s; never overwrite dirty local edits. Matching board revision only when painting run results.

## Security module ownership

Security agent implements server/security.ts exports: readPolicy(env?) -> {remoteEnabled,providerOrigins:string[],mediaOrigins:string[]}; createBoundary({origin,token,dev,policy}) -> Express middleware; validateBaseUrl(url,policy), validateMediaUrl(url,policy,{allowDemo?}?); safeJsonRequest(url,{method:'GET'|'POST',headers,body?,signal},policy) -> Promise<unknown>. Use transport injection in adapters for fixtures. Boundary requires session bootstrap checks above; app handles sending token. Reject inappropriate origins, Host, methods, and token; CSP must allow Vite websocket localhost in dev and inline styles for React Flow, no inline scripts in production.

server/providers.ts exports generate(provider:Provider,request:GenerationRequest, options?:{policy?,env?,transport?,pollIntervalMs?,maxPolls?}):Promise<GenerationOutput>. Transport injected tests avoid real network. Demo returns trusted generated svg data URL or /demo-motion.mp4, records exact referenceUrl through engine. onSubmitted called and awaited once remote id received BEFORE polling. Errors must be safe (no response text/secrets), no retries POST. Schema inputs src/shared/schema.ts exports parseBoard, parseProviders, parseOperations, parseRunInput; schema strict, throws generic safe validation error. Run input includes boardId expectedRevision operationId nodeId? confirmExternal? as API. Security agent may additionally export helpers but coordinate signature changes.

## Graph

prompt -> text; asset -> assetKind; image -> image; video -> video; note no edges. image accepts <=1 text; video <=1 text + <=1 image. No other incoming edges. DAG validation entire graph. selected node run includes ancestors only. prompt input text then own prompt joined newline. video binds first upstream image artifact URL from SAME run to referenceField. Generation count <=20. Upstream failure stops descendants. validate supports malformed references, cycles, incompatible types, missing provider/model.

## UI

Ownership src/ui/** only; can add components/styles. React Flow dark creative canvas, brand Relay Canvas, lime accent, property inspector, board switch/add, add node buttons, save/autosave, import/export board JSON, provider settings panel, history/status/assets, run selection/all/cancel, MCP connection help. User facing Traditional Chinese with tasteful English labels. Show Demo label, remote disabled status, adapter contract tested/live unverified. Avoid fictitious chat assistant. MCP is real external Codex control, not in-app mocked AI. Header version v0.1.0. API tokens in memory only, never localStorage. <img referrerPolicy=no-referrer crossOrigin=anonymous> and video crossOrigin=anonymous. Normalize flow objects before save. Empty/error/loading states functional. Tests need stable aria-label on tools, board-name, prompt editor, save, run, provider settings, export/import. Build initial visual from starterBoard.
