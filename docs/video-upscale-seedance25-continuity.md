# ReachFlow: 1080p preservation upscale + Seedance 2.5 temporal-continuity plan

Status: Draft P0 implementation from GitHub public `main` v0.7.0. Independent from World/Agent PRs and video integrity PRs #6/#8/#10/#12. Does not touch the private Gitea/Jenkins production deployment.

## Deliverable today: FFmpeg 1080p Lanczos

- Save an MP4/WebM video from a successful Run using existing local media save.
- Open Assets; choose the saved video and click `升頻1080p`.
- The authenticated POST `/api/boards/:id/upscale` with `{operationId,source:{runId,nodeId,artifactIndex},preset:'lanczos_1080p'}` starts a durable local export job. Poll existing `/api/exports/:id`; download the completed independent video artifact.
- Source is re-hashed by MediaStore before FFmpeg accepts it. FFmpeg is sandboxed with existing process-group supervisor, loopback-only server, no shell, no paid API and no external network access.
- `scale=...:flags=lanczos:force_original_aspect_ratio=decrease`, padded to 1920x1080 (or portrait 1080x1920); uses source PTS/fps passthrough, no JPEG extraction, no frame interpolator, no new scene generation, and no per-frame color grade.
- Browser-compatible H.264 MP4 uses `yuv420p` and AAC: this is **not lossless chroma preservation**, and Lanczos cannot reconstruct unobserved detail or reverse generative identity drift.
- Existing media quota/64MiB output limit, up to 60s source, cancellation and interrupted-job fencing apply; 1080p or larger sources are rejected.
- Tests check source SHA-256, durable idempotency, auth, dimensions, frame counts and original media immutability.

## Important: CMYK vs YCbCr color and generation loss

CMYK is a print color model. Modern AI video is commonly encoded using YCbCr/YUV and color metadata such as BT.709/BT.601/BT.2020. Progressive color changes may result from color-matrix/range interpretation, RGB/JPEG extraction, chroma subsampling or repeated encoding. A separate process is model-induced drift (identity, clothing, geometry and motion); it can happen even with a perfectly accurate last frame.

For accurate color diagnosis use ffprobe color_primaries, color_transfer, color_space, color_range, pix_fmt, bit_depth and stream time_base before any conversion. Normalize explicitly only when source metadata is known. Do not automatically label an unknown gamut BT.709. Avoid JPEG intermediates; use original video and immutable image anchors. Compare temporal seams (frames across boundaries) after decoding to a shared working color space.

## Seedance 2.5 official capability contract (verified 2026-11-08)

- Announced 2026-07-31; official BytePlus/Volcano documents describe 4-30-second generation and multi-round continuation.
- Model IDs: BytePlus `dreamina-seedance-2-5-260628`; mainland Volcano `doubao-seedance-2-5-260628`.
- Extension: `omni_reference_task_type='extend'`, at least one `reference_video` with explicit extension intent, `ratio='adaptive'`, `duration` integer 4-30 or -1.
- Can refer to up to 30 images, 10 videos, 10 audios; first/last frame modes are also available.
- `output_format='mov'` uses H.264 video with yuv444p chroma + PCM audio and is recommended for video editing/extension where color fidelity matters. Player compatibility may vary.
- `return_last_frame=true` asks API to return a last-frame asset. Download original outputs promptly; output URLs may expire.
- For actual continuation, prefer last **full video** plus independently approved character/scene reference images. Only use first-last-frame mode for planned inbetween sequences; re-extracting last frames and JPEG-encoding them every round should not be the default.

## API integration status

`src/shared/seedance25-continuity.ts` includes an **offline-only request planner**, no provider registration or dispatch. It cannot submit tasks, upload/private-host media, validate official account availability, bill or poll results. A production adapter must use exact configured BytePlus/Volcano domains, authenticated server-held key, supported model feature table, approved media hosting, paid-confirmation gate and output ingest. Existing MediaStore does **not yet support QuickTime MOV/YUV444 archival imports**: future work must retain professional MOV masters losslessly rather than force transcoding everything to MP4.

## Recommended anti-drift design

1. Save original reference images (not generated tails) and verified source video with content hash, color metadata, FPS/time_base and model provenance.
2. On each segment, pass (a) recent full video clip (b) original character/scene reference images and (c) action/motion/camera continuity text to Seedance 2.5 extension.
3. Request native 1080p MOV output and last-frame asset when supported and approved. Store MOV master before producing an H.264 yuv420p delivery copy.
4. Compare boundary frames, color histograms, identity features, depth/motion trajectories and audio seams; use calibrated thresholds and human checks, not brightness alone.
5. If drift exceeds threshold, rollback to latest verified checkpoint and regenerate with original anchors; never automatically promote a drifted last frame to authoritative truth.

## Validation gates

`npm run check`, `npm test`, `npm run test:release`, `npm run build`, selected E2E and package smoke on GitHub. All test footage is synthetic and no paid provider is called. Do not merge or deploy until public/private codebase compatibility, data schema migration, and source safety are reviewed.

Official references:
- https://seed.bytedance.com/en/blog/one-take-creation-flexible-referencing-introducing-seedance-2-5
- https://docs.byteplus.com/zh-TW/docs/modelark/seedance-2-5
- https://docs.byteplus.com/en/docs/modelark/create-video-generation-task-api
- https://www.ffmpeg.org/ffmpeg-filters.html