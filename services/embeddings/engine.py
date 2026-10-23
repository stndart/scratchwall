"""Pinned retrieval pipeline. Importing this module does not load models."""
import math
import os
import tempfile
import subprocess
from pathlib import Path

PIPELINE = "e5-base-siglip2-large-ocr-v2-frames32"
TEXT_MODEL = "intfloat/multilingual-e5-base"
TEXT_REVISION = "d128750597153bb5987e10b1c3493a34e5a4502a"
VISION_MODEL = "google/siglip2-large-patch16-256"
VISION_REVISION = "787800c8990e6f058423089178e718139608408c"


def chunk_spans(length, size=384, overlap=64):
    start = 0
    while start < length:
        end = min(start + size, length)
        yield start, end
        if end == length:
            break
        start = end - overlap


def frame_times(duration):
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("Invalid video duration")
    count = min(32, max(1, math.ceil(duration / 5)))
    return [duration * (i + 1) / (count + 1) for i in range(count)]


def video_duration(path):
    value = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        check=True, capture_output=True, text=True, timeout=30,
    ).stdout.strip()
    return float(value)


def extract_frame(path, timestamp, output):
    subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-threads", "1", "-ss", str(timestamp),
         "-i", str(path), "-an", "-frames:v", "1", "-filter_threads", "1", "-vf",
         "scale=960:960:force_original_aspect_ratio=decrease", str(output)],
        check=True, capture_output=True, timeout=60,
    )


class Engine:
    def __init__(self, threads=2):
        import torch
        from transformers import AutoModel, AutoProcessor, AutoTokenizer
        torch.set_num_threads(threads)
        torch.set_num_interop_threads(1)
        self.torch = torch
        self.tokenizer = AutoTokenizer.from_pretrained(TEXT_MODEL, revision=TEXT_REVISION)
        self.text_model = AutoModel.from_pretrained(TEXT_MODEL, revision=TEXT_REVISION, use_safetensors=True).eval()
        self.processor = AutoProcessor.from_pretrained(VISION_MODEL, revision=VISION_REVISION, use_fast=False)
        self.vision_model = AutoModel.from_pretrained(VISION_MODEL, revision=VISION_REVISION, use_safetensors=True).eval()

    def text_chunks(self, text):
        tokens = self.tokenizer.encode(text, add_special_tokens=False, verbose=False)
        return [self.tokenizer.decode(tokens[start:end]) for start, end in chunk_spans(len(tokens))]

    def text(self, text, query=False):
        batch = self.tokenizer(("query: " if query else "passage: ") + text,
                               max_length=512, truncation=True, padding=True, return_tensors="pt")
        with self.torch.inference_mode():
            hidden = self.text_model(**batch).last_hidden_state
            mask = batch["attention_mask"]
            pooled = hidden.masked_fill(~mask[..., None].bool(), 0).sum(1) / mask.sum(1)[..., None]
            return self.torch.nn.functional.normalize(pooled, p=2, dim=1)[0].tolist()

    def visual_query(self, text):
        batch = self.processor(text=[text], padding="max_length", max_length=64, truncation=True, return_tensors="pt")
        with self.torch.inference_mode():
            features = self.vision_model.get_text_features(**batch)
            return self.torch.nn.functional.normalize(features, p=2, dim=1)[0].tolist()

    def image(self, path: Path):
        from PIL import Image, ImageOps
        with Image.open(path) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
            batch = self.processor(images=image, return_tensors="pt")
        with self.torch.inference_mode():
            features = self.vision_model.get_image_features(**batch)
            return self.torch.nn.functional.normalize(features, p=2, dim=1)[0].tolist()


def image_text(path: Path):
    """Bounded sparse Cyrillic/English OCR, used exclusively as vector input."""
    from PIL import Image, ImageOps, ImageStat
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
        image.thumbnail((2400, 2400))
        gray = ImageOps.grayscale(image)
        # Tesseract prefers dark lettering on light backgrounds.
        if ImageStat.Stat(gray).mean[0] < 128:
            gray = ImageOps.invert(gray)
        with tempfile.TemporaryDirectory(prefix="scratchwall-ocr-") as directory:
            prepared = Path(directory) / "image.png"
            gray.save(prepared)
            result = subprocess.run(
                ["tesseract", str(prepared), "stdout", "-l", "rus+eng", "--psm", "11"],
                check=True, capture_output=True, text=True, timeout=45,
                env={**os.environ, "OMP_THREAD_LIMIT": "1"},
            )
    return result.stdout.strip()[:16000]
