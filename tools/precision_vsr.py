#!/usr/bin/env python3
"""ReachFlow Precision Temporal VSR (experimental, non-generative).

No GAN, diffusion, external API or learned face synthesis. This worker fuses
verified neighboring observations using optical flow, rejects inconsistent
motion/scene cuts and back-projects against the actual source frame.

Input: local constant-frame-rate SDR video; Output: FFV1/gbrp16le MKV master.
The RGB decode is not a bit-identical copy of source YUV. Reconstruction
cannot recreate features that were never recorded in any source frame.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Any, Iterator

import cv2
import numpy as np

VERSION = "precision-temporal-vsr-v0.1"
MAX_FRAMES = 900
MAX_DIMENSION = 1920
MAX_SCALE = 4.0
MAX_RADIUS = 2


def run_checked(args: list[str], *, timeout: int = 45) -> bytes:
    result = subprocess.run(args, capture_output=True, timeout=timeout, check=False)
    if result.returncode:
        stderr = result.stderr.decode("utf-8", "replace")[-700:]
        raise RuntimeError(f"Media tool failed ({result.returncode}): {stderr}")
    return result.stdout


def rational(s: str) -> float:
    parts = s.split("/")
    if len(parts) != 2:
        raise ValueError(f"Not a rational frame rate: {s}")
    numerator, denominator = (int(v) for v in parts)
    if numerator <= 0 or denominator <= 0:
        raise ValueError("Non-positive frame rate")
    return numerator / denominator


def inspect_source(path: Path) -> dict[str, Any]:
    result = json.loads(run_checked([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-count_frames", "-show_entries",
        "stream=codec_name,pix_fmt,width,height,r_frame_rate,avg_frame_rate,sample_aspect_ratio,nb_read_frames,color_primaries,color_transfer,color_space,color_range:format=duration",
        "-of", "json", str(path),
    ]))
    streams = result.get("streams", [])
    if len(streams) != 1:
        raise ValueError("Exactly one primary video stream is required")
    st = streams[0]
    w, h = int(st.get("width", 0)), int(st.get("height", 0))
    frames = int(st.get("nb_read_frames", 0))
    fps = rational(st.get("avg_frame_rate", "0/0"))
    r_fps = rational(st.get("r_frame_rate", "0/0"))
    duration = float(result["format"].get("duration", 0))
    if (not 64 <= w <= MAX_DIMENSION or not 64 <= h <= MAX_DIMENSION
            or w * h > 1280 * 720 or not 2 <= frames <= MAX_FRAMES
            or not 1 <= fps <= 60 or not 0 < duration <= 30
            or abs(fps - r_fps) > 0.01):
        raise ValueError("Source exceeds precision VSR limits or is not CFR")
    if st.get("sample_aspect_ratio", "1:1") not in ("1:1", "N/A"):
        raise ValueError("Non-square pixels require prior explicit normalization")
    if st.get("color_transfer") in ("smpte2084", "arib-std-b67"):
        raise ValueError("HDR requires a separate transfer-aware pipeline")
    times = json.loads(run_checked([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_frames", "-show_entries", "frame=best_effort_timestamp_time",
        "-of", "json", str(path),
    ], timeout=60)).get("frames", [])
    if len(times) != frames:
        raise ValueError("Frame metadata and decoded count disagree")
    pts = [float(f["best_effort_timestamp_time"]) for f in times]
    for i in range(1, len(pts)):
        if abs((pts[i] - pts[i - 1]) - 1 / fps) > max(0.002, 0.15 / fps):
            raise ValueError("Variable frame-rate input is not supported")
    return {
        "width": w, "height": h, "frames": frames,
        "fps": fps, "fps_rational": st["avg_frame_rate"],
        "duration": duration, "codec": st.get("codec_name"),
        "pix_fmt": st.get("pix_fmt"),
        "color_primaries": st.get("color_primaries", "unspecified"),
        "color_transfer": st.get("color_transfer", "unspecified"),
        "color_space": st.get("color_space", "unspecified"),
        "color_range": st.get("color_range", "unspecified"),
    }


def destination_size(w: int, h: int, target_height: int | None, scale: float | None) -> tuple[int, int]:
    if (target_height is None) == (scale is None):
        raise ValueError("Specify exactly one of target_height or scale")
    if target_height is not None:
        if target_height not in (720, 1080):
            raise ValueError("Target height must be 720 or 1080")
        ratio = target_height / (h if w >= h else w)
    else:
        ratio = float(scale)
    if not 1.05 <= ratio <= MAX_SCALE:
        raise ValueError("Upscale factor must be in [1.05, 4]")
    out_w = int(round(w * ratio / 2) * 2)
    out_h = int(round(h * ratio / 2) * 2)
    if out_w > 3840 or out_h > 3840:
        raise ValueError("Output is too large")
    return out_w, out_h


def flow_reference_to_neighbor(ref: np.ndarray, neighbor: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return LR optical flow and conservative alignment confidence."""
    h, w = ref.shape[:2]
    ref_gray = cv2.cvtColor(np.uint8(np.clip(ref * 255, 0, 255)), cv2.COLOR_RGB2GRAY)
    nbr_gray = cv2.cvtColor(np.uint8(np.clip(neighbor * 255, 0, 255)), cv2.COLOR_RGB2GRAY)
    if float(np.median(np.abs(ref_gray.astype(np.int16) - nbr_gray.astype(np.int16)))) > 52:
        return np.zeros((h, w, 2), dtype=np.float32), np.zeros((h, w), dtype=np.float32)
    params = (0.5, 3, 15, 3, 5, 1.2, 0)
    forward = cv2.calcOpticalFlowFarneback(ref_gray, nbr_gray, None, *params)
    backward = cv2.calcOpticalFlowFarneback(nbr_gray, ref_gray, None, *params)
    xx, yy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    map_x = xx + forward[..., 0]
    map_y = yy + forward[..., 1]
    aligned = cv2.remap(neighbor, map_x, map_y, cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT_101)
    inverse = cv2.remap(backward, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    fb_error = np.linalg.norm(forward + inverse, axis=2)
    photo_error = np.mean(np.abs(aligned - ref), axis=2)
    valid = (map_x >= 1) & (map_x <= w - 2) & (map_y >= 1) & (map_y <= h - 2)
    confidence = (np.exp(-((fb_error / 1.2) ** 2)) *
                  np.exp(-((photo_error / 0.08) ** 2)) * valid).astype(np.float32)
    confidence[confidence < 0.1] = 0
    return forward, confidence


def reconstruct_frame(frames: list[np.ndarray], center: int, out_size: tuple[int, int], *,
                      temporal_strength: float = 0.45, backprojection_steps: int = 3) -> np.ndarray:
    """Optical-flow multi-frame fusion with measured low-resolution data consistency."""
    if not frames or not 0 <= center < len(frames):
        raise ValueError("Invalid central frame")
    ref = frames[center]
    if any(f.shape != ref.shape or f.dtype != np.float32 for f in frames):
        raise ValueError("Every frame must be float32 RGB with the same dimensions")
    if ref.ndim != 3 or ref.shape[2] != 3:
        raise ValueError("Expected RGB frames")
    if not 0 <= temporal_strength <= 0.8 or not 0 <= backprojection_steps <= 5:
        raise ValueError("Unsafe restoration controls")
    h, w = ref.shape[:2]
    out_w, out_h = out_size
    if out_w <= w or out_h <= h:
        raise ValueError("Must upscale both dimensions")
    base = cv2.resize(ref, out_size, interpolation=cv2.INTER_LANCZOS4)
    accum = base.copy()
    weights = np.ones((out_h, out_w), dtype=np.float32)
    xx, yy = np.meshgrid((np.arange(out_w, dtype=np.float32) + 0.5) * w / out_w - 0.5,
                         (np.arange(out_h, dtype=np.float32) + 0.5) * h / out_h - 0.5)
    for i, neighbor in enumerate(frames):
        if i == center:
            continue
        flow, confidence = flow_reference_to_neighbor(ref, neighbor)
        if not np.any(confidence):
            continue
        flow_x = cv2.resize(flow[..., 0], out_size, interpolation=cv2.INTER_LINEAR)
        flow_y = cv2.resize(flow[..., 1], out_size, interpolation=cv2.INTER_LINEAR)
        sampled = cv2.remap(neighbor, xx + flow_x, yy + flow_y, cv2.INTER_CUBIC,
                            borderMode=cv2.BORDER_REFLECT_101)
        weight = (temporal_strength / max(1, abs(i - center)) *
                  cv2.resize(confidence, out_size, interpolation=cv2.INTER_LINEAR)).astype(np.float32)
        accum += sampled * weight[..., None]
        weights += weight
    result = accum / weights[..., None]
    for _ in range(backprojection_steps):
        observed = cv2.resize(result, (w, h), interpolation=cv2.INTER_AREA)
        residual = ref - observed
        result += 0.8 * cv2.resize(residual, out_size, interpolation=cv2.INTER_LINEAR)
        result = np.clip(result, 0, 1)
    return result.astype(np.float32)


def decode_rgb48(path: Path, meta: dict[str, Any]) -> Iterator[np.ndarray]:
    w, h = meta["width"], meta["height"]
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
            "-i", str(path), "-map", "0:v:0", "-an", "-sn", "-dn",
            "-pix_fmt", "rgb48le", "-fps_mode", "passthrough",
            "-f", "rawvideo", "pipe:1"]
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    frame_bytes = w * h * 3 * 2
    try:
        assert process.stdout is not None
        for _ in range(meta["frames"]):
            buf = process.stdout.read(frame_bytes)
            if len(buf) != frame_bytes:
                raise RuntimeError("Decoder produced incomplete RGB48 frame")
            image = np.frombuffer(buf, dtype="<u2").reshape(h, w, 3)
            yield np.array(image, dtype=np.float32) / 65535.0
        if process.stdout.read(1):
            raise RuntimeError("Decoder unexpectedly emitted extra frames")
        if process.wait(timeout=30) != 0:
            raise RuntimeError("Decoder rejected video stream")
    finally:
        if process.poll() is None:
            process.kill()
        process.communicate()


def process_video(source: Path, output: Path, *, target_height: int | None = 1080,
                  scale: float | None = None, temporal_strength: float = 0.45,
                  radius: int = 2) -> dict[str, Any]:
    if not source.is_file() or source.is_symlink() or output.exists() or source.resolve() == output.resolve():
        raise ValueError("Input must be a local file and output must not exist")
    if not 0 <= radius <= MAX_RADIUS:
        raise ValueError("Frame radius must be between zero and two")
    meta = inspect_source(source)
    out_size = destination_size(meta["width"], meta["height"], target_height, scale)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="precision-vsr-", dir=str(output.parent)) as temp:
        tmp = Path(temp)
        video_only = tmp / "video_only.mkv"
        encoded = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
            "-f", "rawvideo", "-pixel_format", "rgb48le", "-video_size", f"{out_size[0]}x{out_size[1]}",
            "-framerate", meta["fps_rational"], "-i", "pipe:0",
            "-an", "-c:v", "ffv1", "-level", "3", "-pix_fmt", "gbrp16le",
            "-y", str(video_only),
        ]
        encoder = subprocess.Popen(encoded, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        decoder = decode_rgb48(source, meta)
        window: dict[int, np.ndarray] = {}
        next_read = 0
        produced = 0
        try:
            assert encoder.stdin is not None
            for t in range(meta["frames"]):
                while next_read < min(meta["frames"], t + radius + 1):
                    window[next_read] = next(decoder)
                    next_read += 1
                indexes = list(range(max(0, t - radius), min(meta["frames"], t + radius + 1)))
                images = [window[j] for j in indexes]
                restored = reconstruct_frame(images, indexes.index(t), out_size,
                                             temporal_strength=temporal_strength)
                encoded_frame = np.uint16(np.clip(np.rint(restored * 65535.0), 0, 65535))
                encoder.stdin.write(encoded_frame.astype("<u2", copy=False).tobytes())
                produced += 1
                for past in list(window):
                    if past < t + 1 - radius:
                        del window[past]
            encoder.stdin.close()
            encoder.stdin = None
            if encoder.wait(timeout=240) != 0:
                raise RuntimeError("Lossless video encoder failed")
        except Exception:
            if encoder.poll() is None:
                encoder.kill()
            raise
        finally:
            decoder.close()
            if encoder.poll() is None:
                encoder.kill()
            encoder.communicate()
        run_checked([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
            "-i", str(video_only), "-i", str(source),
            "-map", "0:v:0", "-map", "1:a?", "-map_metadata", "1",
            "-c:v", "copy", "-c:a", "copy", "-y", str(tmp / "final.mkv"),
        ], timeout=90)
        if not (tmp / "final.mkv").is_file():
            raise RuntimeError("Failed to finalize restoration output")
        (tmp / "final.mkv").replace(output)
    return {
        "version": VERSION, "input": str(source), "output": str(output),
        "inputMetadata": meta, "outputWidth": out_size[0], "outputHeight": out_size[1],
        "outputCodec": "ffv1", "outputPixelFormat": "gbrp16le",
        "inputFrames": meta["frames"], "outputFrames": produced,
        "temporalStrength": temporal_strength, "temporalRadius": radius,
        "method": "optical_flow_multiframe_fusion_with_lr_backprojection",
        "generativeModelUsed": False,
        "limitations": [
            "No reconstruction can guarantee original details absent from all source frames.",
            "Alignment errors and scene changes are screened but not perfectly eliminated.",
            "YCbCr-to-RGB conversion and output color metadata require transfer-aware validation.",
            "Variable-framerate, HDR and non-square-pixel video inputs are deliberately rejected.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Non-generative multi-frame restoration with source data consistency")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="New MKV FFV1 master; never overwrites input")
    targets = parser.add_mutually_exclusive_group()
    targets.add_argument("--target-height", type=int, choices=(720, 1080), default=1080)
    targets.add_argument("--scale", type=float)
    parser.add_argument("--temporal-strength", type=float, default=0.45)
    parser.add_argument("--radius", type=int, default=2, choices=(0, 1, 2))
    args = parser.parse_args()
    report = process_video(args.input, args.output,
        target_height=None if args.scale is not None else args.target_height,
        scale=args.scale, temporal_strength=args.temporal_strength, radius=args.radius)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
