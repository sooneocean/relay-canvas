import type { Express } from 'express';
import { CanvasService } from './service.js';
import { VideoIntegrityLedger } from './video-integrity-ledger.js';
import { buildVideoSignalEvidence } from '../src/shared/video-signal.js';
import { AppError } from './graph.js';

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
  });  app.post('/api/boards/:id/video-integrity/candidates/:candidateId/signal-evidence', async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length !== 0) {
      throw new AppError('INVALID_VIDEO_INPUT', 'Signal evidence request must be an empty object.', 400);
    }
    const id = boardId(req.params.id), candidateId = String(req.params.candidateId);
    const { candidate, artifact } = ledger.analysisSource(id, candidateId);
    let evidence;
    try {
      const info = await service.editor.probe(artifact);
      const measuredMs = Math.round(info.duration * 1000);
      const declaredMs = candidate.endMs - candidate.startMs;
      if (!Number.isSafeInteger(measuredMs) || measuredMs < 1000 || measuredMs > 60_000 ||
        Math.abs(measuredMs - declaredMs) > Math.max(600, declaredMs * 0.05)) {
        throw new AppError('VIDEO_DURATION_MISMATCH', 'Candidate duration differs from verified source media.', 409);
      }
      const frames = await service.editor.signalFrames(artifact);
      evidence = buildVideoSignalEvidence(frames, measuredMs);
    } catch (error) {
      if (error instanceof AppError) throw error;
      const unavailable = error instanceof Error && /unavailable|busy/i.test(error.message);
      throw new AppError(unavailable ? 'VIDEO_SIGNAL_UNAVAILABLE' : 'VIDEO_SIGNAL_FAILED',
        unavailable ? 'Video signal analysis is unavailable.' : 'Video signal analysis failed; no verification was recorded.',
        unavailable ? 503 : 422);
    }
    res.json({
      boardId: id, candidateId, artifactSha256: artifact.sha256,
      source: 'verified_local_video', evidence,
    });
  });

}
