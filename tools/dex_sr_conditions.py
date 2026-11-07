"""DE-X SR P0: immutable reference assets and conservative same-view detail transfer.

Inputs:
  - a FULL, verified prior VIDEO CLIP (handled by precision_vsr.process_video);
  - up to eight locally stored original still references;
  - a human-written prompt used only to choose bounded numerical restoration
    policy. The prompt is NEVER sent to a generative model here.

Reference photos from other angles remain metadata-only: no unregistered
feature is pasted into a face or scene. Pixel transfer is only attempted for
'detail'/'scene' references whose low-resolution projection closely matches
the actual source frame. The worker can always fall back to temporal-only SR.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
from pathlib import Path
import re

import cv2
import numpy as np

MAX_REFERENCES = 8
MAX_REFERENCE_BYTES = 30 * 1024 * 1024
MAX_PROMPT_LENGTH = 1200
ALLOWED_ROLES = frozenset(("identity", "detail", "scene", "color"))
MAX_PIXEL_GAIN = 0.35
MAX_MATCH_MAE = 0.035


@dataclass(frozen=True)
class ReferenceAsset:
    path: Path
    role: str
    sha256: str
    rgb: np.ndarray


@dataclass(frozen=True)
class RestorationPolicy:
    intent: str
    prompt_sha256: str
    temporal_strength: float
    reference_strength: float
    matching_threshold: float
    identity_lock: bool = True
    allow_generation: bool = False


def policy_from_prompt(prompt: str, temporal: float = 0.45,
                       reference: float = 0.30) -> RestorationPolicy:
    if not isinstance(prompt, str) or len(prompt) > MAX_PROMPT_LENGTH:
        raise ValueError("Prompt must be a bounded string")
    if not np.isfinite(temporal) or not 0 <= temporal <= 0.8:
        raise ValueError("Invalid temporal strength")
    if not np.isfinite(reference) or not 0 <= reference <= MAX_PIXEL_GAIN:
        raise ValueError("Invalid reference detail strength")
    text = prompt.lower()
    strict = any(term in text for term in (
        "保真", "保持五官", "不改五官", "維持人臉", "preserve identity",
        "identity lock", "original likeness", "strict", "不要生成",
    ))
    grain = any(term in text for term in ("保留顆粒", "preserve grain", "grain intact"))
    if strict:
        temporal, reference = min(temporal, 0.3), min(reference, 0.25)
    if grain:
        temporal = min(temporal, 0.15)
    intent = "strict_fidelity" if strict else "grain_preserving" if grain else "conservative"
    return RestorationPolicy(
        intent=intent,
        prompt_sha256=hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
        temporal_strength=float(temporal),
        reference_strength=float(reference),
        matching_threshold=MAX_MATCH_MAE,
    )


def parse_reference_spec(spec: str) -> tuple[str, Path]:
    if not isinstance(spec, str) or ":" not in spec:
        raise ValueError("Reference must be ROLE:/absolute/local/image.png")
    role, name = spec.split(":", 1)
    if role not in ALLOWED_ROLES or not name:
        raise ValueError("Unsupported reference role or path")
    path = Path(name)
    if not path.is_absolute() or not path.is_file() or path.is_symlink():
        raise ValueError("Reference must be a regular absolute local file")
    if path.suffix.lower() not in (".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp"):
        raise ValueError("Unsupported reference image format")
    if path.stat().st_size <= 0 or path.stat().st_size > MAX_REFERENCE_BYTES:
        raise ValueError("Reference image file exceeds quota")
    return role, path


def load_references(specs: list[str]) -> list[ReferenceAsset]:
    if len(specs) > MAX_REFERENCES:
        raise ValueError("Too many reference images")
    references: list[ReferenceAsset] = []
    seen: set[str] = set()
    for spec in specs:
        role, path = parse_reference_spec(spec)
        sha = hashlib.sha256(path.read_bytes()).hexdigest()
        if sha in seen:
            raise ValueError("Duplicate original reference")
        seen.add(sha)
        im = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
        if im is None or im.ndim != 3 or im.shape[2] != 3:
            raise ValueError("Reference image must contain 3 color channels")
        if not 64 <= im.shape[0] <= 4096 or not 64 <= im.shape[1] <= 4096:
            raise ValueError("Unsupported reference dimensions")
        if im.dtype == np.uint8:
            rgb = cv2.cvtColor(im, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        elif im.dtype == np.uint16:
            rgb = cv2.cvtColor(im, cv2.COLOR_BGR2RGB).astype(np.float32) / 65535.0
        else:
            raise ValueError("Unsupported reference image bit depth")
        references.append(ReferenceAsset(path, role, sha, rgb))
    return references


def inject_measured_reference_detail(
    high: np.ndarray,
    low: np.ndarray,
    references: list[ReferenceAsset],
    policy: RestorationPolicy,
    backprojection_steps: int = 3,
) -> tuple[np.ndarray, dict[str, object]]:
    """Transfer ONLY observed same-view high-frequency residuals.

    A reference is ineligible if the visible low-resolution image disagrees
    with the corresponding actual input frame; no semantic face re-creation.
    """
    if high.ndim != 3 or low.ndim != 3 or high.shape[2] != 3 or low.shape[2] != 3:
        raise ValueError("Expected RGB frame data")
    if high.dtype != np.float32 or low.dtype != np.float32:
        raise ValueError("Expected float32 RGB arrays")
    hh, hw = high.shape[:2]
    lh, lw = low.shape[:2]
    if hw <= lw or hh <= lh or not 0 <= backprojection_steps <= 5:
        raise ValueError("Invalid reference transfer dimensions")
    record: dict[str, object] = {
        "selectedReferenceSha256": None,
        "matchedReferenceRole": None,
        "sameViewMeanError": None,
        "detailTransferApplied": False,
        "unmatchedReferences": len(references),
        "identityPhotosWereNeverPasted": True,
    }
    if not references or policy.reference_strength == 0:
        return high.copy(), record

    candidates: list[tuple[float, ReferenceAsset, np.ndarray, np.ndarray]] = []
    for ref in references:
        if ref.role not in ("detail", "scene"):
            continue
        rh, rw = ref.rgb.shape[:2]
        if rh < hh or rw < hw:
            continue
        if abs((rw / rh) - (hw / hh)) > 0.005:
            continue
        full = cv2.resize(ref.rgb, (hw, hh), interpolation=cv2.INTER_AREA)
        reduced = cv2.resize(full, (lw, lh), interpolation=cv2.INTER_AREA)
        mae = float(np.mean(np.abs(reduced - low)))
        if mae <= policy.matching_threshold:
            candidates.append((mae, ref, full, reduced))
    if not candidates:
        return high.copy(), record
    mae, selected, full, reduced = min(candidates, key=lambda item: item[0])
    # Only matched pixels can accept residual details; different face positions
    # or expressions are rejected even if a global match is broadly similar.
    local_difference = np.mean(np.abs(reduced - low), axis=2)
    mask = (local_difference < policy.matching_threshold).astype(np.float32)
    mask = cv2.erode(mask, np.ones((3, 3), dtype=np.uint8), iterations=1)
    mask = cv2.resize(mask, (hw, hh), interpolation=cv2.INTER_LINEAR)
    mask = np.clip(cv2.GaussianBlur(mask, (5, 5), 0.8), 0.0, 1.0)
    if np.mean(mask) < 0.30:
        return high.copy(), record

    # Remove all low-frequency color/shape information from the reference.
    # Only high-frequency pixels already measured in the matched reference
    # survive. The source frame supplies color, silhouettes and global form.
    highpass = full - cv2.resize(reduced, (hw, hh), interpolation=cv2.INTER_CUBIC)
    gain = policy.reference_strength * max(
        0.0, 1.0 - mae / policy.matching_threshold,
    )
    result = np.clip(high + gain * mask[..., None] * highpass, 0.0, 1.0)
    for _ in range(backprojection_steps):
        projected = cv2.resize(result, (lw, lh), interpolation=cv2.INTER_AREA)
        correction = low - projected
        result = np.clip(result + 0.8 * cv2.resize(
            correction, (hw, hh), interpolation=cv2.INTER_LINEAR,
        ), 0.0, 1.0)

    record.update({
        "selectedReferenceSha256": selected.sha256,
        "matchedReferenceRole": selected.role,
        "sameViewMeanError": round(mae, 6),
        "detailTransferApplied": True,
        "unmatchedReferences": len(references) - 1,
    })
    return result.astype(np.float32), record
