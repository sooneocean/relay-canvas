import express, { type ErrorRequestHandler } from 'express';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createBoundary, validateBaseUrl, validateMediaUrl } from './security.js';
import { CanvasService } from './service.js';
import { AppError } from './graph.js';

export function createApp(service: CanvasService, origin: string, token = randomBytes(32).toString('hex'), dev = false) {
  const app = express();
  app.disable('x-powered-by');
  app.use(createBoundary({ origin, token, dev, policy: service.policy }));
  app.use(express.json({ limit: '6mb', strict: true }));
  app.get('/healthz', (_req, res) => { res.json({ ok: true, version: '0.2.0' }); });
  app.get('/api/session', (_req, res) => { res.json({ token }); });
  app.get('/api/state', (_req, res) => { res.json(service.state()); });
  app.post('/api/boards', (req, res) => { res.status(201).json(service.create(req.body?.name)); });
  app.put('/api/boards/:id', (req, res) => {
    const board = req.body?.board;
    if (Array.isArray(board?.nodes)) for (const node of board.nodes) if (node?.data?.assetUrl) validateMediaUrl(node.data.assetUrl, service.policy);
    res.json(service.save(String(req.params.id), req.body?.expectedRevision, board));
  });
  app.post('/api/boards/:id/patch', (req, res) => { res.json(service.patch(String(req.params.id), req.body?.expectedRevision, req.body?.operations)); });
  app.post('/api/boards/:id/validate', (req, res) => { res.json(service.validate(String(req.params.id), req.body?.nodeId)); });
  app.put('/api/providers', (req, res) => {
    if (Array.isArray(req.body?.providers)) for (const p of req.body.providers) if (p?.protocol !== 'demo' && p?.baseUrl) validateBaseUrl(p.baseUrl, service.policy);
    res.json(service.providers(req.body?.providers));
  });
  app.post('/api/runs', (req, res) => { res.status(202).json(service.start(req.body)); });
  app.get('/api/runs/:id', (req, res) => { res.json(service.getRun(String(req.params.id))); });
  app.post('/api/runs/:id/cancel', (req, res) => { res.json(service.cancel(String(req.params.id))); });
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'API endpoint not found', code: 'NOT_FOUND' }); });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof AppError) res.status(error.status).json({ error: error.message, code: error.code });
    else res.status(400).json({ error: '輸入或設定無效，請確認資料格式、允許的來源與欄位上限。', code: 'INVALID_INPUT' });
  };
  app.use(errors);
  return { app, token };
}

export function serveProduction(app: express.Express, root: string) {
  app.use(express.static(path.join(root, 'dist'), { dotfiles: 'deny', index: 'index.html' }));
  app.get('/{*path}', (_req, res) => { res.sendFile(path.join(root, 'dist/index.html')); });
}
