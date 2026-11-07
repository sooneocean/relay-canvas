# Precision Temporal VSR P0 — Non-generative, source-constrained video restoration

Status: **draft offline worker**, stacked on PR #14. It is not integrated into the ReachFlow browser, existing /api/runs or MediaStore. No provider/paid tasks, diffusion, GAN, GFPGAN, face swapping or identity synthesis.

## Actual algorithm

1. Probe the actual original video with FFprobe. Require constant frame rate (verify per-frame timestamps), square pixels, SDR, 2-900 frames, at most 30 seconds, at most 1280×720 input. Reject unsupported VFR, HDR and malformed input instead of silently dropping/interpolating frames.
2. Decode each native frame directly through FFmpeg RGB48LE pipe, **never JPEG extraction**.
3. Compute bidirectional Farneback optical flow from reference to nearby frames (radius 0-2), forward-backward cycle error, and photometric residual.
4. Reject hard scene cuts, occluded/out-of-bounds locations and poor alignments; confidence-weight only observed nearby pixels.
5. Fuse all trusted observations at target resolution. Preserve the original frame as the dominant estimate; run 3 iterative backprojection steps so reducing the output approximately recovers the original input. This prevents uncontrolled high-frequency detail insertion.
6. Output original number of frames and frame rate as losslessly encoded **FFV1/gbrp16le (RGB 16-bit) MKV**. Stream-copy original audio where supported. The source file is never overwritten.

Mathematical optimization target (conceptual):

    H_t* = argmin_H Σ_j w(t,j) || D W(t→j) H - L_j ||² + λ || D H - L_t ||² + μ R(H)

Where H is high-res reconstruction, L_j are source frames, W is frame alignment and D is an observation/downsampling operator. This prototype approximates that objective with photometric/flow-weighted fusion and iterative reference backprojection. It is **not** a full optimizer or pretrained Topaz model.

## Run locally

Requirements: Python 3.11+, OpenCV/Python, NumPy, FFmpeg/FFprobe available in PATH.

    python -m pip install -r tools/requirements-precision-vsr.txt
    python tools/precision_vsr.py --input shot_480p.mp4 --output shot_precision_1080p.mkv --target-height 1080 --radius 2 --temporal-strength 0.45

To test on a smaller synthetic clip:

    python tools/precision_vsr.py --input fixture.mp4 --output fixture_2x.mkv --scale 2 --radius 1
    python -m unittest discover -s tests -p 'test_precision_vsr.py' -v

## Portrait preservation and boundaries

- This pipeline never uses a face identity model to **invent** eyes, skin pores, hairstyle or facial landmarks.
- If adjacent observations contain complementary details, optical flow can improve temporal signal recovery over a single-frame resize. In noisy, highly compressed or changing footage, it may produce similar or softer results. Quality improvement is **not guaranteed**.
- Source data consistency reduces accidental morphology drift, but cannot prove correct face identity. Flow can be wrong on rotating faces, occlusions, low-texture skin and motion blur. The confidence gate limits but does not eliminate errors.
- The FFV1 output is lossless with respect to computed RGB16 pixels; **YUV-to-RGB decode is not necessarily reversible** and the input may be 8-bit or 4:2:0. Color primaries/transfer are recorded but not fully normalized by this worker. Do not claim original colorimetry is recovered.
- No new frames or video generation occur. No source is resubmitted to a generative model. This cannot correct a true identity shift that the prior video model already generated.
- CLI output is MKV and may not be directly playable in all web browsers. A separate delivery MP4 would be another (potentially lossy) encoding pass; preserve the MKV master.

## Comparison to Topaz

Official Topaz categorizes **Proteus** as Precision Upscaling and **Starlight** as Generative Upscaling. **Proteus Natural** is aimed at subtle natural improvements and fewer distorted small faces. Iris is optimized for faces but can also regenerate detail. This open worker should be benchmarked against Proteus Natural/Proteus rather than called an Iris-equivalent.

Suggested future, with a strict non-GAN/non-diffusion preset: PSNR/SSIM-trained BasicVSR++ via OpenMMLab MMagic for learned feature propagation, then **reprojection consistency**, reference-frame blending, forward-backward motion masks and face geometry measurement. Even an L1/PSNR model may predict unsupported textures; it must not be trusted as ground truth.

## Verification and future integration

- Python unit tests cover exact frame count, FFmpeg audio stream copy, source immutability, LR reprojection consistency, hard cut rejection, invalid enlargement and output lossless codec.
- Separate GitHub Actions workflow installs optional deps and runs deterministic fixture tests.
- Next PR: safe sandboxed worker adapter, owned local asset only, input digest, process group, resource/time/cancellation limits, output quota, separate immutable master and preview MP4, optional crop-aware human face region guard.
- Product benchmarking: 480p→1080p and 720p→1080p; report source downprojection MAE/PSNR, temporal warping error (occlusion-masked), face-landmark stability and manual identity errors. Use hold-out synthetic GT where original high-resolution frames exist. Never use sharpness alone as the acceptance criterion.

Relevant sources:
- https://developer.topazlabs.com/
- https://docs.topazlabs.com/topaz-video/filters/enhancement
- https://github.com/open-mmlab/mmagic/tree/main/configs/basicvsr_pp
- https://github.com/open-mmlab/mmagic
- https://github.com/JingyunLiang/RVRT (research CC-BY-NC; do not include in commercial bundle without review)