import type { Express } from 'express';
import { CanvasService } from './service.js';
import { VideoIntegrityLedger } from './video-integrity-ledger.js';

/**
 * P0-b local-only sidecar API. Existing createBoundary middleware handles
 * Origin/Host/session token protection before these routes execute.
 */
export function registerVideoIntegrityRoutes(app: Express, service: CanvasService): void {
  const ledger = new VideoIntegrityLedger(service);
  const boardId = (value: unknown) => String(value);
  app.get('/api/boards/:id/video-integrity', (req, res) => {
    res.json(ledger.view(boardId(req.params.id)));
  });
  app.post('/api/boards/:id/video-integrity/anchors', (req, res) => {
    const receipt = ledger.registerAnchor(boardId(req.params.id), req.body);
    res.status(receipt.replayed ? 200 : 201).json(receipt);
  });
  app.post('/api/boards/:id/video-integrity/candidates', (req, res) => {
    const receipt = ledger.registerCandidate(boardId(req.params.id), req.body);
    res.status(receipt.replayed ? 200 : 201).json(receipt);
  });
  app.post('/api/boards/:id/video-integrity/candidates/:candidateId/approve', (req, res) => {
    const receipt = ledger.approveCandidate(boardId(req.params.id), String(req.params.candidateId), req.body);
    res.status(receipt.replayed ? 200 : 201).json(receipt);
  });
  app.post('/api/boards/:id/video-integrity/candidates/:candidateId/reject', (req, res) => {
    const receipt = ledger.rejectCandidate(boardId(req.params.id), String(req.params.candidateId), req.body);
    res.status(receipt.replayed ? 200 : 201).json(receipt);
  });
}
