import sys
from pathlib import Path
import subprocess
import tempfile
import unittest

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
from precision_vsr import reconstruct_frame, destination_size, process_video, inspect_source


def color(c, shape=(64, 96)):
    return np.full((shape[0], shape[1], 3), np.array(c, np.float32), dtype=np.float32)


class PrecisionVsrTest(unittest.TestCase):
    def test_identical_static_frames_preserve_color(self):
        src = color([0.2, 0.6, 0.3])
        out = reconstruct_frame([src, src, src], 1, (192, 128))
        self.assertEqual(out.shape, (128, 192, 3))
        self.assertLess(np.max(np.abs(cv2.resize(out, (96, 64), interpolation=cv2.INTER_AREA) - src)), 0.005)

    def test_scene_cut_does_not_bleed_previous_color(self):
        red = color([1.0, 0.0, 0.0])
        blue = color([0.0, 0.0, 1.0])
        out = reconstruct_frame([red, blue, blue], 1, (192, 128))
        center = out[20:108, 20:172].mean(axis=(0, 1))
        self.assertLess(center[0], 0.005)
        self.assertGreater(center[2], 0.99)

    def test_motion_alignment_keeps_original_low_res_data(self):
        h, w = 64, 96
        rng = np.random.default_rng(21)
        pattern = cv2.GaussianBlur(rng.random((h,w,3), dtype=np.float32), (3,3), 0.8)
        left = np.roll(pattern, -1, axis=1).astype(np.float32)
        right = np.roll(pattern, 1, axis=1).astype(np.float32)
        out = reconstruct_frame([left, pattern, right], 1, (192,128))
        replay = cv2.resize(out, (w,h), interpolation=cv2.INTER_AREA)
        self.assertLess(np.mean(np.abs(replay - pattern)), 0.015)
        self.assertTrue(np.isfinite(out).all())

    def test_size_boundaries(self):
        self.assertEqual(destination_size(854,480,1080,None), (1920, 1080))
        self.assertEqual(destination_size(480,854,1080,None), (1080,1920))
        with self.assertRaises(ValueError): destination_size(64,64,1080,None)
        with self.assertRaises(ValueError): destination_size(1920,1080,1080,None)

    def test_real_ffmpeg_video_frame_count_fps_and_audio(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root)/'source.mp4'
            out = Path(root)/'restored.mkv'
            subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-nostdin',
                '-f','lavfi','-i','testsrc2=size=96x64:rate=6:duration=2',
                '-f','lavfi','-i','sine=frequency=500:sample_rate=48000:duration=2',
                '-map','0:v:0','-map','1:a:0','-c:v','libx264','-pix_fmt','yuv420p',
                '-preset','ultrafast','-crf','26','-c:a','aac','-b:a','64k','-y',str(source)],
                check=True,timeout=20)
            source_copy=source.read_bytes()
            meta=inspect_source(source)
            report=process_video(source,out,target_height=None,scale=2.0,radius=1)
            self.assertEqual(report['inputFrames'],12)
            self.assertEqual(report['outputFrames'],12)
            self.assertEqual(report['generativeModelUsed'],False)
            self.assertEqual(source.read_bytes(),source_copy)
            streams=subprocess.check_output(['ffprobe','-v','error',
                '-show_entries','stream=codec_name,codec_type,pix_fmt,width,height',
                '-of','json',str(out)])
            import json
            streams=json.loads(streams)['streams']
            video=next(s for s in streams if s['codec_type']=='video')
            self.assertEqual(video['codec_name'],'ffv1')
            self.assertEqual((video['width'],video['height']),(192,128))
            self.assertTrue(any(s['codec_type']=='audio' for s in streams))
            self.assertEqual(inspect_source(out)['frames'], 12)
            with self.assertRaises(ValueError): process_video(source,out,target_height=None,scale=2.0)


if __name__=='__main__':
    unittest.main()
