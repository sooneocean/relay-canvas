import sys
from pathlib import Path
import hashlib
import subprocess
import tempfile
import unittest

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
from dex_sr_conditions import (
    inject_measured_reference_detail, load_references, policy_from_prompt,
)
from precision_vsr import process_video, inspect_source


def image(color, size=(128, 192)):
    return np.full((*size, 3), color, dtype=np.float32)


def make_clip(file: Path, rate=6, seconds=2):
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "lavfi", "-i", f"testsrc2=size=96x64:rate={rate}:duration={seconds}",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "24",
        "-pix_fmt", "yuv420p", "-y", str(file),
    ], check=True, timeout=20)


class DexSrConditionsTest(unittest.TestCase):
    def test_prompt_constraints_are_bounded_and_cannot_enable_generation(self):
        policy = policy_from_prompt("請保真，保持五官，不要生成新細節；保留顆粒", 0.65, 0.35)
        self.assertEqual(policy.intent, "strict_fidelity")
        self.assertLessEqual(policy.temporal_strength, 0.15)
        self.assertLessEqual(policy.reference_strength, 0.25)
        self.assertTrue(policy.identity_lock)
        self.assertFalse(policy.allow_generation)
        self.assertEqual(len(policy.prompt_sha256), 64)
        for args in [("x" * 1201, 0.45, 0.30), ("ok", 2.0, 0.30),
                     ("ok", 0.45, 0.99)]:
            with self.assertRaises(ValueError):
                policy_from_prompt(*args)

    def test_multiple_original_images_are_hashed_and_identity_is_metadata_only(self):
        with tempfile.TemporaryDirectory() as d:
            a, b = Path(d) / "master.png", Path(d) / "identity.png"
            cv2.imwrite(str(a), np.uint8(image([60, 80, 120], (128, 192))))
            cv2.imwrite(str(b), np.uint8(image([90, 120, 140], (128, 192))))
            refs = load_references([f"detail:{a}", f"identity:{b}"])
            self.assertEqual(len(refs), 2)
            self.assertEqual(refs[0].sha256, hashlib.sha256(a.read_bytes()).hexdigest())
            self.assertEqual(refs[1].role, "identity")
            with self.assertRaises(ValueError):
                load_references([f"identity:{a}", f"detail:{a}"])
            with self.assertRaises(ValueError):
                load_references([f"detail:{Path(d) / 'missing.png'}"])

    def test_same_view_high_resolution_evidence_contributes_real_detail(self):
        with tempfile.TemporaryDirectory() as d:
            rng = np.random.default_rng(41)
            high = cv2.GaussianBlur(rng.random((128, 192, 3), dtype=np.float32),
                                    (3, 3), 0.5)
            high_uint = np.uint8(np.clip(np.rint(high * 255), 0, 255))
            imagefile = Path(d) / "observed.png"
            cv2.imwrite(str(imagefile), cv2.cvtColor(high_uint, cv2.COLOR_RGB2BGR))
            truth = high_uint.astype(np.float32) / 255.0
            low = cv2.resize(truth, (96, 64), interpolation=cv2.INTER_AREA)
            baseline = cv2.resize(low, (192, 128), interpolation=cv2.INTER_LANCZOS4)
            refs = load_references([f"detail:{imagefile}"])
            restored, evidence = inject_measured_reference_detail(
                baseline.copy(), low, refs, policy_from_prompt("", 0.45, 0.35))
            self.assertTrue(evidence["detailTransferApplied"])
            self.assertEqual(evidence["selectedReferenceSha256"], refs[0].sha256)
            psnr = lambda value: -10 * np.log10(np.mean((np.clip(value, 0, 1) - truth) ** 2))
            self.assertGreater(psnr(restored), psnr(baseline) + 1)
            projected = cv2.resize(restored, (96, 64), interpolation=cv2.INTER_AREA)
            self.assertLess(np.mean(np.abs(projected - low)), 0.01)

    def test_nonmatching_references_cannot_paste_new_faces_or_change_colors(self):
        with tempfile.TemporaryDirectory() as d:
            red, blue = Path(d) / "red.png", Path(d) / "blue.png"
            cv2.imwrite(str(red), np.uint8(image([240, 0, 0])))
            cv2.imwrite(str(blue), np.uint8(image([0, 0, 240])))
            low = image([0, 0, 1], (64, 96))
            base = cv2.resize(low, (192, 128), interpolation=cv2.INTER_LANCZOS4)
            refs = load_references([f"identity:{blue}", f"detail:{red}"])
            restored, evidence = inject_measured_reference_detail(
                base, low, refs, policy_from_prompt("保持五官"))
            self.assertFalse(evidence["detailTransferApplied"])
            np.testing.assert_array_equal(restored, base)

    def test_prior_video_segment_and_multi_refs_are_consumed_without_new_frames(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            previous, current = root / "previous.mp4", root / "current.mp4"
            restored = root / "restored.mkv"
            make_clip(previous, rate=6)
            make_clip(current, rate=6)
            source_sha = hashlib.sha256(current.read_bytes()).hexdigest()
            identity = root / "person.png"
            scene = root / "scene.png"
            cv2.imwrite(str(identity), np.uint8(image([100, 100, 100])))
            cv2.imwrite(str(scene), np.uint8(image([50, 50, 50])))
            report = process_video(
                current, restored, target_height=None, scale=2.0, radius=2,
                previous_clip=previous,
                reference_specs=[f"identity:{identity}", f"scene:{scene}"],
                prompt="保真，保持五官與服裝；保留顆粒",
            )
            self.assertFalse(report["generativeModelUsed"])
            self.assertEqual(report["previousSegment"]["acceptedContextFrames"], 2)
            self.assertEqual(report["inputFrames"], report["outputFrames"])
            self.assertEqual(inspect_source(restored)["frames"], report["inputFrames"])
            self.assertEqual(len(report["originalReferenceAssets"]), 2)
            self.assertEqual(report["promptPolicy"]["allowGeneration"], False)
            self.assertEqual(report["measuredReferenceDetailAppliedFrames"], 0)
            self.assertEqual(hashlib.sha256(current.read_bytes()).hexdigest(), source_sha)
            with self.assertRaises(ValueError):
                process_video(current, root / "bad.mkv",
                    target_height=None, scale=2.0, previous_clip=current)

    def test_context_clip_fps_mismatch_rejected_before_processing(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            prev, current = root / "p.mp4", root / "c.mp4"
            make_clip(prev, rate=12)
            make_clip(current, rate=6)
            out = root / "result.mkv"
            with self.assertRaises(ValueError):
                process_video(current, out, target_height=None, scale=2.0,
                              previous_clip=prev)
            self.assertFalse(out.exists())


if __name__ == "__main__":
    unittest.main()
