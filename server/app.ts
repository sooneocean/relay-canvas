import express, { type ErrorRequestHandler } from 'express';
import path from 'node:path';
import { createReadStream, read } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createBoundary, validateBaseUrl, validateMediaUrl } from './security.js';
import { CanvasService } from './service.js';
import { AppError } from './graph.js';

export function createApp(service: CanvasService, origin: string, token = randomBytes(32).toString('hex'), dev = false) {
  const app = express();
  app.disable('x-powered-by');
  app.use(createBoundary({ origin, token, dev, policy: service.policy }));
  app.use(express.json({ limit: '6mb', strict: true }));
  app.get('/healthz', (_req, res) => { res.json({ ok: true, version: '0.4.0' }); });
  app.get('/api/session', (_req, res) => {
    res.setHeader('Set-Cookie', `relay_canvas_media=${token}; HttpOnly; SameSite=Strict; Path=/api/media`);
    res.json({ token });
  });
  app.get('/api/state', (_req, res) => { res.json(service.state()); });
  app.post('/api/boards', (req, res) => { res.status(201).json(service.create(req.body?.name)); });
  app.put('/api/boards/:id', (req, res) => {
    const board = req.body?.board;
    if (Array.isArray(board?.nodes)) for (const node of board.nodes) if (node?.data?.assetUrl) validateMediaUrl(node.data.assetUrl, service.policy);
    res.json(service.save(String(req.params.id), req.body?.expectedRevision, board));
  });
  app.post('/api/boards/:id/patch', (req, res) => { res.json(service.patch(String(req.params.id), req.body?.expectedRevision, req.body?.operations)); });
  app.post('/api/boards/:id/validate', (req, res) => { res.json(service.validate(String(req.params.id), req.body?.nodeId)); });
  app.get('/api/editor/capabilities', async (_req, res) => { res.json(await service.editor.capabilities()); });
  app.get('/api/boards/:id/timeline', (req, res) => { res.json(service.timeline(String(req.params.id))); });
  app.put('/api/boards/:id/timeline', async (req, res) => { res.json(await service.saveTimeline(String(req.params.id), req.body)); });
  app.post('/api/boards/:id/exports', (req, res) => { res.status(202).json(service.startExport(String(req.params.id), req.body)); });
  app.get('/api/boards/:id/compare', (req, res) => {
    if (Object.keys(req.query).some(key => key !== 'left' && key !== 'right') || typeof req.query.left !== 'string' || typeof req.query.right !== 'string') throw new AppError('INVALID_INPUT', '比較參數無效。', 400);
    res.json(service.compare(String(req.params.id), req.query.left, req.query.right));
  });
  app.put('/api/providers', (req, res) => {
    if (Array.isArray(req.body?.providers)) for (const p of req.body.providers) if (p?.protocol !== 'demo' && p?.baseUrl) validateBaseUrl(p.baseUrl, service.policy);
    res.json(service.providers(req.body?.providers));
  });
  app.get('/api/providers/diagnostics', (_req, res) => { res.json(service.diagnostics()); });
  app.get('/api/providers/:id/models', async (req, res) => { res.json(await service.models(String(req.params.id))); });
  app.post('/api/runs', (req, res) => { res.status(202).json(service.start(req.body)); });
  app.get('/api/runs/:id', (req, res) => { res.json(service.getRun(String(req.params.id))); });
  app.post('/api/runs/:id/cancel', (req, res) => { res.json(service.cancel(String(req.params.id))); });
  app.post('/api/runs/:runId/artifacts/:nodeId/:index/save', async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length !== 0) throw new AppError('INVALID_INPUT', '請求內容必須為空物件。', 400);
    if (!/^(?:0|[1-9][0-9]?)$/.test(String(req.params.index))) throw new AppError('INVALID_INPUT', '素材索引無效。', 400);
    const index = Number(req.params.index);
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abort); res.once('close', abort);
    try { res.json(await service.saveArtifact(String(req.params.runId), String(req.params.nodeId), index, controller.signal)); }
    finally { req.off('aborted', abort); res.off('close', abort); }
  });
  app.get('/api/runs/:runId/artifacts/:nodeId/:index/info', async (req, res) => {
    if (!/^(?:0|[1-9][0-9]?)$/.test(String(req.params.index))) throw new AppError('INVALID_INPUT', '素材索引無效。', 400);
    res.json(await service.artifactInfo(String(req.params.runId), String(req.params.nodeId), Number(req.params.index)));
  });
  app.get('/api/exports/:id', (req, res) => { res.json(service.getExport(String(req.params.id))); });
  app.post('/api/exports/:id/cancel', async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length !== 0) throw new AppError('INVALID_INPUT', '請求內容必須為空物件。', 400);
    res.json(await service.cancelExport(String(req.params.id)));
  });
  const sendMedia: express.RequestHandler = (req, res) => {
    const artifact = service.mediaArtifact(String(req.params.localId));
    let located: ReturnType<typeof service.media.fileFor>;
    try { located = service.media.fileFor(artifact); } catch { throw new AppError('NOT_FOUND', '找不到素材。', 404); }
    const size = located.size;
    res.setHeader('Content-Type', artifact.mimeType!);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (artifact.mimeType === 'image/svg+xml') res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    const range = req.get('range');
    let start = 0, end = size - 1;
    if (range !== undefined) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) {
        service.media.releaseFile(located.fd); res.setHeader('Content-Range', `bytes */${size}`); res.status(416).end(); return;
      }
      if (!match[1]) {
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0) { service.media.releaseFile(located.fd); res.setHeader('Content-Range', `bytes */${size}`); res.status(416).end(); return; }
        start = Math.max(0, size - suffix);
      } else {
        start = Number(match[1]); end = match[2] ? Number(match[2]) : end;
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
        service.media.releaseFile(located.fd); res.setHeader('Content-Range', `bytes */${size}`); res.status(416).end(); return;
      }
      end = Math.min(end, size - 1);
      res.status(206); res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    res.setHeader('Content-Length', String(end - start + 1));
    if (req.method === 'HEAD') { service.media.releaseFile(located.fd); res.end(); return; }
    let ownsLease = true;
    const releaseLease = () => {
      if (!ownsLease) return;
      ownsLease = false;
      service.media.releaseFile(located.fd);
    };
    let stream: ReturnType<typeof createReadStream>;
    try {
      stream = createReadStream(located.file, {
        fd: located.fd,
        autoClose: true,
        start,
        end,
        fs: {
          read,
          close: (_fd, callback) => { releaseLease(); callback(null); },
        },
      });
    } catch (error) {
      releaseLease();
      throw error;
    }
    const cleanup = () => { stream.destroy(); };
    res.once('close', cleanup);
    stream.once('close', () => { res.off('close', cleanup); });
    stream.on('error', () => { res.destroy(); }).pipe(res);
  };
  app.head('/api/media/:localId', sendMedia);
  app.get('/api/media/:localId', sendMedia);
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
