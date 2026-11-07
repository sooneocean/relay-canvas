# Video Integrity P1-a: Real Video Signal Evidence

Status: **Draft, opt-in, read-only, screening-only**. Stacked on PR #8 (which stacks on PR #6). Keep draft pending code review and production Gitea/Jenkins reconciliation.

## Goal

Detect objective low-resolution luminance changes from actual saved video bytes. This is not identity recognition, semantic consistency assessment, optical flow, temporal-motion verification or proof that a static camera shot is frozen.

## API

POST /api/boards/:id/video-integrity/candidates/:candidateId/signal-evidence; JSON body {}. All existing local Origin/Host/X-Canvas-Token rules apply.

Response returns boardId, candidateId, artifactSha256, source=verified_local_video and a video signal evidence object. The evidence includes scorerVersion=ffmpeg-signalstats-v1, sampleRateHz=2, resolution=64x36, durationMs, coverageFraction, totalFrames, meanYDifference, peakYDifference, observations, bounded frames and autoApprovalEligible=false.

## Trusted data flow

1. Look up a registered candidate on the same board, including all trusted anchors and optional approved parent checkpoint.
2. Re-verify the bytes and SHA-256 of candidate/anchor/parent via MediaStore with board ownership.
3. Probe actual duration via existing supervised FFprobe and compare against declared candidate interval; tolerance is max(600ms, 5%).
4. Use EditorRuntime private workspace + copyVerified + process-group supervisor to decode video with FFmpeg, no shell or remote network input.
5. FFmpeg samples 2fps at 64x36 and outputs frame YAVG/YDIF from signalstats/metadata=print; parser validates bounded samples, monotonic cadence and at least 90% clip duration coverage.
6. Return a read-only report; never create a checkpoint or change the integrity ledger.

## Review-only observations

- brightness_jump: abrupt sampled average luminance and YDIF change; cuts and camera flashes are legitimate possible causes.
- sustained_low_change: at least four half-second frame transitions with almost no pixel change; can occur in intended static shots.
- luma_oscillation: four sequential alternating high-amplitude luminance changes; intentional lighting and rapid scene cuts may trigger.

All observations are preliminary heuristics with interpretation=review_only and autoApprovalEligible=false. Their thresholds are not calibrated on ground-truth annotations. Missing FFmpeg/invalid footage/short or incomplete decode fails closed.

## Operational boundaries

- FFmpeg/FFprobe 6+ required; at most one active signal analysis per EditorRuntime.
- Max 120 low-res sampled frames, 60 seconds, 256KiB metadata output, 30s decode deadline. Reuses trusted, locally registered media; no paid provider calls.
- Candidate media, anchor, and parent checkpoints must resolve and re-hash successfully. No raw paths or arbitrary remote URLs from clients.
- Only local session token exists; this is not named human authorization.
- Existing generation routes are not globally gated. No quality approval or auto-repair is introduced.

## Tests and follow-ups

Run npm run check; npm test; npm run test:release; npm run build. Added pure-parser/heuristic tests and HTTP integration tests using real FFmpeg-generated MP4, including authorization, no-write behavior and duration mismatch.

Next: add immutable scorer attestation with input+binary version digests, calibrated detector signals for motion/identity, then connect them to an opt-in controlled video continuation route. Do not infer identity preservation from brightness screening.