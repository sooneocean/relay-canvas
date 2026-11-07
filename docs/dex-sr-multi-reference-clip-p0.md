# DE-X SR P0 — Prior video clip + multiple immutable original images + prompt policy

Status: stacked Draft proposal on PR #15 (Precision Temporal VSR); no deployment, merge or paid calls. DE-X SR is the user's proposed engineering name, not an academic algorithm or an existing Topaz feature.

## Technical decision: separate restoration from video generation

**Precision restoration:** input source video, optional *previous continuous video segment* (typically final 2-4 seconds of the previous shot), up to 8 original still images, author instructions. Output a new FFV1/gbrp16le MKV master with the same number of frames and FPS as the source. No diffusion, GAN, image synthesis, Seedance extension or external API call. Only mathematically observed original details can be transferred.

**Generative continuation (separate future dispatch):** full preceding clip, original image anchors, action/camera prompt through a vendor-specific `extend` API. New frames are synthesized; do not call that non-generative SR. Official Volcano Engine Seedance 2.5 supports `omni_reference_task_type=extend` with reference_video+reference_image, and ratio adaptive.

## Concrete worker behavior

1. `--previous-clip prev2to4sec.mp4` must be distinct, 1–8 seconds, constant FPS, same dimensions/FPS as `--input`, with no explicit conflicting color metadata. The entire previous file is decoded; the last *two* observed frames condition the start of the current shot (and one conditions the following frame). This avoids JPEG extraction and demonstrates real multi-frame boundary input. Context motion modeling beyond these two frames is future work.
2. `--reference identity:/absolute/person-original.png` registers an immutable still in provenance. Identity/face reference images are **never pasted** into arbitrary video frames and no identity recognition claim is made.
3. `--reference detail:/absolute/same-shot-original.png` or `scene:` may contribute high-frequency observed pixels only if the full image has sufficient resolution, consistent aspect and very low downscaled difference to a current source frame. Mismatched scenes, face poses and color changes fail closed. The transfer uses a high-pass residual from the measured original, conservative local masks and 3 low-resolution data-consistency backprojection iterations.
4. `--reference color:` is tracked, but does **not** automatically recolor footage; color metadata/gamut must be verified before this can be implemented.
5. `--prompt` is a **bounded deterministic policy**. Supported words such as 保真/保持五官/不改五官/preserve identity cap temporal/reference strength; 保留顆粒/preserve grain further limits smoothing. The prompt cannot enable an LLM, generative inpainting, face synthesis, or unrestricted numeric values. Unrecognized words are stored only as a SHA-256 prompt digest; they do not change pixels.

## Example command

```bash
python -m pip install -r tools/requirements-precision-vsr.txt
python tools/precision_vsr.py \
  --input next_480p.mp4 \
  --previous-clip previous_last_4s_480p.mp4 \
  --reference identity:/absolute/person-original.png \
  --reference detail:/absolute/high-res-same-shot-reference.png \
  --reference scene:/absolute/scene-master.png \
  --prompt '保真，保持五官與服裝；保留顆粒；不要生成新細節' \
  --target-height 1080 --radius 2 \
  --temporal-strength 0.45 --reference-strength 0.30 \
  --output restored_1080p.mkv
```

Strict prompt and grain will lower the effective temporal weight to 0.15 and reference detail gain to at most 0.25. The actual applied values are included in the JSON output.

## ReachFlow read-only planning endpoint

POST `/api/boards/:id/dex-sr/plan` (same local Host, Origin and X-Canvas-Token protection as other APIs):

```json
{
  "schemaVersion": 1,
  "currentVideo": {"artifactSha256": "<sha-of-saved-clip>"},
  "previousSegment": {"artifactSha256": "<sha-of-previous-saved-clip>"},
  "originals": [
    {"artifactSha256": "<sha-of-imported-portrait>", "role": "identity"},
    {"artifactSha256": "<sha-of-imported-scene>", "role": "detail"}
  ],
  "prompt": "保真，保持五官，保留顆粒，不要生成新細節",
  "temporalRadius": 2,
  "targetHeight": 1080
}
```

Server re-verifies exact source media bytes and same-board ownership. Reference images must have been imported to the current board, not simply present on disk under a chosen name. It checks clip duration/dimensions with FFprobe but leaves exact FPS, color metadata and geometric matches for the worker. The result explicitly says `status=plan_only`, `runnable=false`. **No remote or local processing is dispatched** by this endpoint yet. A production-grade runner must stage immutable assets into a private sandbox, bound CPU/RAM/time, carry cancellation and rehash before execution.

## Non-generative honesty and unresolved problems

- Same-view measured reference high-frequency transfer can improve actual detail but is strict; multiview front/side photos do not supply a mathematically valid mapping onto a different facial pose. Therefore they are recorded rather than hallucinated.
- Optical flow alignment of previous two frames is only accepted where bidirectional error/photo evidence passes. A cut or changed person should not be blended.
- Every added original still photo is hashed, but an uploaded photo is **not automatically proven to show the correct person**. True face identity verification will require a separately calibrated model and privacy-aware human review.
- The FFV1 output is lossless for the worker's computed RGB pixels, not a bit-perfect reproduction of the source YCbCr transfer function.
- Even strict VSR can create ringing or alignment ghosts. Benchmark against Topaz Proteus Natural and BasicVSR++ reconstruction-mode weights using source-fidelity, masked temporal warp error, high-resolution ground truth PSNR/SSIM, face landmark drift and blinded human comparison.
- The extension mode should prefer official video_clip `reference_video` plus image `reference_image` and prompt, but this is a distinct generative model call requiring account/fee confirmation.

## Verification

Python tests cover strict prompt handling, multi-image SHA tracking, no-paste identity policy, reference mismatch rejection, measured same-view high-frequency transfer against synthetic GT, real previous clip frame conditioning, frame-count preservation, prior clip FPS rejection.

Node/HTTP tests cover same-board SHA-verified source ownership, duplicate source guard, cross-board/incorrect MIME/unknown fields rejection, no-write plan and Origin/Session Token authentication.

Commands:

```bash
python -m unittest discover -s tests -p 'test_precision_vsr.py' -v
python -m unittest discover -s tests -p 'test_dex_sr_conditions.py' -v
npm run check && npm test && npm run build
```

## Research

- RefVSR++, WACV 2025: https://openaccess.thecvf.com/content/WACV2025/html/Zou_RefVSR_Exploiting_Reference_Inputs_for_Reference-Based_Video_Super-Resolution_WACV_2025_paper.html
- TCSAF RefBank, 2026: https://www.sciencedirect.com/science/article/pii/S0957417426007311
- Official Seedance 2.5 reference/extension spec: https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh