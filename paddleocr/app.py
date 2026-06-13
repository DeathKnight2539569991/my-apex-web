from __future__ import annotations

import asyncio
import json
import os
import secrets
import threading
import time
from dataclasses import dataclass
from io import BytesIO
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from PIL import Image, UnidentifiedImageError


ALLOWED_IMAGE_TYPES = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
}

OCR_API_TOKEN = os.getenv("OCR_API_TOKEN", "").strip()
if not OCR_API_TOKEN:
    raise RuntimeError("OCR_API_TOKEN is required.")

MAX_BYTES = int(os.getenv("OCR_MAX_BYTES", str(10 * 1024 * 1024)))
QUEUE_TIMEOUT_SECONDS = float(os.getenv("OCR_QUEUE_TIMEOUT_SECONDS", "60"))

app = FastAPI(title="Apex PaddleOCR Service", version="1.0.0")
ocr_slots = asyncio.Semaphore(1)
engine: Optional[Any] = None
engine_lock = threading.Lock()
engine_load_lock = threading.Lock()


@dataclass(frozen=True)
class OcrOptions:
    crop_mode: str = "none"
    preprocess: str = "none"
    upscale: bool = False


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "ok": True,
        "engineLoaded": engine is not None,
        "maxBytes": MAX_BYTES,
        "queueTimeoutSeconds": QUEUE_TIMEOUT_SECONDS,
    }


@app.post("/ocr")
async def ocr(
    file: UploadFile = File(...),
    authorization: str = Header(""),
    crop_mode: str = Form("none"),
    preprocess: str = Form("none"),
    upscale: bool = Form(False),
) -> Dict[str, Any]:
    verify_token(authorization)
    verify_content_type(file.content_type)

    image_bytes = await file.read(MAX_BYTES + 1)
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    if len(image_bytes) > MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"Image must be <= {MAX_BYTES} bytes.")

    try:
        await asyncio.wait_for(ocr_slots.acquire(), timeout=QUEUE_TIMEOUT_SECONDS)
    except asyncio.TimeoutError as exc:
        raise HTTPException(status_code=503, detail="OCR queue is busy. Please try again later.") from exc

    try:
        return await run_in_threadpool(
            recognize_image_bytes,
            image_bytes,
            OcrOptions(crop_mode=crop_mode, preprocess=preprocess, upscale=upscale),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        ocr_slots.release()


def verify_token(authorization: str) -> None:
    expected = f"Bearer {OCR_API_TOKEN}"
    if not secrets.compare_digest(authorization.strip(), expected):
        raise HTTPException(status_code=401, detail="Invalid OCR token.")


def verify_content_type(content_type: Optional[str]) -> None:
    mime = (content_type or "").split(";", 1)[0].strip().lower()
    if mime not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail="Only png, jpg, jpeg, and webp images are supported.")


def recognize_image_bytes(image_bytes: bytes, options: OcrOptions) -> Dict[str, Any]:
    if options.crop_mode not in {"stats-panel", "none"}:
        raise ValueError("crop_mode must be 'stats-panel' or 'none'.")
    if options.preprocess not in {"none", "binarize"}:
        raise ValueError("preprocess must be 'none' or 'binarize'.")

    started_at = time.perf_counter()
    source_image = load_image(image_bytes)
    processed_image, crop, scale = prepare_image(source_image, options)
    processed_array = np.asarray(processed_image)

    ocr_engine = get_engine()
    with engine_lock:
        raw_result = predict(ocr_engine, processed_array)

    lines = normalize_result(raw_result, crop, scale)
    text = "\n".join(line["text"] for line in lines if line["text"])
    confidence = average_confidence(lines)

    return {
        "text": text,
        "confidence": confidence,
        "lines": lines,
        "elapsedMs": round((time.perf_counter() - started_at) * 1000),
    }


def get_engine() -> Any:
    global engine

    if engine is not None:
        return engine

    with engine_load_lock:
        if engine is None:
            engine = create_engine()
        return engine


def create_engine() -> Any:
    from paddleocr import PaddleOCR

    params: Dict[str, Any] = {
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
        "device": env_value("PADDLE_OCR_DEVICE", "cpu"),
        "enable_mkldnn": env_bool("PADDLE_OCR_ENABLE_MKLDNN", False),
    }
    add_optional(params, "lang", env_value("PADDLE_OCR_LANG"))
    add_optional(params, "ocr_version", env_value("PADDLE_OCR_VERSION"))
    add_optional(params, "text_detection_model_name", env_value("PADDLE_OCR_TEXT_DETECTION_MODEL_NAME"))
    add_optional(params, "text_recognition_model_name", env_value("PADDLE_OCR_TEXT_RECOGNITION_MODEL_NAME"))
    add_optional(params, "cpu_threads", env_int("PADDLE_OCR_CPU_THREADS"))

    try:
        return PaddleOCR(**params)
    except TypeError:
        legacy_params: Dict[str, Any] = {"use_angle_cls": False, "lang": env_value("PADDLE_OCR_LANG", "ch")}
        if env_value("PADDLE_OCR_DEVICE", "cpu").startswith("gpu"):
            legacy_params["use_gpu"] = True
        return PaddleOCR(**legacy_params)


def predict(ocr_engine: Any, image: np.ndarray) -> Any:
    if hasattr(ocr_engine, "predict"):
        return ocr_engine.predict(image)
    if hasattr(ocr_engine, "ocr"):
        return ocr_engine.ocr(image, cls=False)
    raise RuntimeError("Unsupported PaddleOCR engine object.")


def load_image(image_bytes: bytes) -> Image.Image:
    try:
        return Image.open(BytesIO(image_bytes)).convert("RGB")
    except UnidentifiedImageError as exc:
        raise ValueError("Uploaded file is not a readable image.") from exc


def prepare_image(image: Image.Image, options: OcrOptions) -> Tuple[Image.Image, Dict[str, int], float]:
    crop = choose_crop(image.width, image.height, options.crop_mode)
    processed = image.crop((crop["x"], crop["y"], crop["x"] + crop["width"], crop["y"] + crop["height"]))

    scale = choose_scale(crop["width"], options.crop_mode) if options.upscale else 1.0
    if scale != 1:
        resampling = getattr(getattr(Image, "Resampling", Image), "LANCZOS")
        processed = processed.resize((round(processed.width * scale), round(processed.height * scale)), resampling)

    if options.preprocess == "binarize":
        processed = binarize(processed)

    return processed, crop, scale


def choose_crop(width: int, height: int, crop_mode: str) -> Dict[str, int]:
    if crop_mode == "none":
        return {"x": 0, "y": 0, "width": width, "height": height}

    aspect = width / height if height else 1
    crop_ratio = 0.34 if aspect > 1.1 else 0.49 if aspect >= 0.62 else 1
    return {"x": 0, "y": 0, "width": round(width * crop_ratio), "height": height}


def choose_scale(crop_width: int, crop_mode: str) -> float:
    if crop_mode == "none" and crop_width > 900:
        return 1.0
    if crop_width < 260:
        return 4.0
    if crop_width < 520:
        return 3.0
    return 2.0


def binarize(image: Image.Image) -> Image.Image:
    rgb = np.asarray(image.convert("RGB"), dtype=np.float32)
    red = rgb[:, :, 0]
    green = rgb[:, :, 1]
    blue = rgb[:, :, 2]
    luminance = red * 0.299 + green * 0.587 + blue * 0.114
    orange_boost = np.where((red > 150) & (green > 55) & (red > blue * 1.35), red * 0.88, 0)
    gray = np.maximum(luminance, orange_boost).clip(0, 255).astype(np.uint8)
    threshold = min(max(otsu_threshold(gray) + 8, 88), 176)
    binary = np.where(gray >= threshold, 0, 255).astype(np.uint8)
    return Image.fromarray(np.stack([binary, binary, binary], axis=-1), "RGB")


def otsu_threshold(gray: np.ndarray) -> int:
    histogram = np.bincount(gray.ravel(), minlength=256).astype(np.float64)
    total_pixels = gray.size
    total = float(np.dot(np.arange(256), histogram))
    background_weight = 0.0
    background_sum = 0.0
    max_variance = 0.0
    threshold = 120

    for value in range(256):
        background_weight += histogram[value]
        if background_weight == 0:
            continue

        foreground_weight = total_pixels - background_weight
        if foreground_weight == 0:
            break

        background_sum += value * histogram[value]
        background_mean = background_sum / background_weight
        foreground_mean = (total - background_sum) / foreground_weight
        variance = background_weight * foreground_weight * (background_mean - foreground_mean) ** 2
        if variance > max_variance:
            max_variance = variance
            threshold = value

    return threshold


def normalize_result(raw_result: Any, crop: Dict[str, int], scale: float) -> List[Dict[str, Any]]:
    if isinstance(raw_result, list) and raw_result and looks_like_legacy_result(raw_result):
        return normalize_legacy_result(raw_result, crop, scale)

    lines: List[Dict[str, Any]] = []
    pages = raw_result if isinstance(raw_result, list) else [raw_result]
    for page in pages:
        page_data = result_to_data_dict(page)
        texts = to_sequence(page_data.get("rec_texts"))
        scores = to_sequence(page_data.get("rec_scores"))
        boxes = to_sequence(page_data.get("rec_boxes"))
        raw_polys = page_data.get("rec_polys")
        if raw_polys is None:
            raw_polys = page_data.get("dt_polys")
        polys = to_sequence(raw_polys)

        for index, raw_text in enumerate(texts):
            text = str(raw_text).strip()
            if not text:
                continue

            score = to_float(item_at(scores, index))
            raw_box = item_at(boxes, index)
            if raw_box is None:
                raw_box = item_at(polys, index)
            processed_box = make_box(raw_box)
            source_box = map_box_to_source(processed_box, crop, scale) if processed_box else None
            lines.append({"text": text, "confidence": score, "box": source_box})

    return lines


def normalize_legacy_result(raw_result: Any, crop: Dict[str, int], scale: float) -> List[Dict[str, Any]]:
    lines: List[Dict[str, Any]] = []
    for item in iter_legacy_items(raw_result):
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            continue

        raw_box = item[0]
        raw_recognition = item[1]
        if not isinstance(raw_recognition, (list, tuple)) or len(raw_recognition) < 2:
            continue

        text = str(raw_recognition[0]).strip()
        if not text:
            continue

        processed_box = make_box(raw_box)
        source_box = map_box_to_source(processed_box, crop, scale) if processed_box else None
        lines.append({"text": text, "confidence": to_float(raw_recognition[1]), "box": source_box})

    return lines


def looks_like_legacy_result(raw_result: List[Any]) -> bool:
    first = raw_result[0]
    if isinstance(first, (list, tuple)) and first and looks_like_legacy_line(first[0]):
        return True
    return looks_like_legacy_line(first)


def looks_like_legacy_line(value: Any) -> bool:
    return (
        isinstance(value, (list, tuple))
        and len(value) >= 2
        and isinstance(value[1], (list, tuple))
        and len(value[1]) >= 2
    )


def iter_legacy_items(raw_result: Any) -> Iterable[Any]:
    if isinstance(raw_result, (list, tuple)) and len(raw_result) == 1 and isinstance(raw_result[0], (list, tuple)):
        yield from raw_result[0]
        return
    yield from raw_result


def result_to_data_dict(result: Any) -> Dict[str, Any]:
    payload: Any
    if isinstance(result, dict):
        payload = result
    elif hasattr(result, "json"):
        payload = result.json
        if callable(payload):
            payload = payload()
    elif hasattr(result, "__dict__"):
        payload = result.__dict__
    else:
        return {}

    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            return {}

    if isinstance(payload, dict):
        nested = payload.get("res")
        return nested if isinstance(nested, dict) else payload

    return {}


def make_box(raw_box: Any) -> Optional[List[int]]:
    box = to_plain(raw_box)
    if not isinstance(box, list) or not box:
        return None

    if len(box) == 4 and all(isinstance(value, (int, float)) for value in box):
        return [round(float(value)) for value in box]

    points = [point for point in box if isinstance(point, list) and len(point) >= 2]
    if not points:
        return None

    xs = [float(point[0]) for point in points]
    ys = [float(point[1]) for point in points]
    return [round(min(xs)), round(min(ys)), round(max(xs)), round(max(ys))]


def map_box_to_source(box: Sequence[int], crop: Dict[str, int], scale: float) -> List[int]:
    return [
        round(box[0] / scale + crop["x"]),
        round(box[1] / scale + crop["y"]),
        round(box[2] / scale + crop["x"]),
        round(box[3] / scale + crop["y"]),
    ]


def average_confidence(lines: Sequence[Dict[str, Any]]) -> Optional[float]:
    scores = [line["confidence"] for line in lines if isinstance(line.get("confidence"), (int, float))]
    return round(float(sum(scores) / len(scores)), 4) if scores else None


def to_sequence(value: Any) -> List[Any]:
    if value is None:
        return []
    value = to_plain(value)
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    return [value]


def to_plain(value: Any) -> Any:
    if hasattr(value, "tolist"):
        value = value.tolist()
    if isinstance(value, tuple):
        return [to_plain(item) for item in value]
    if isinstance(value, list):
        return [to_plain(item) for item in value]
    if isinstance(value, np.generic):
        return value.item()
    return value


def item_at(values: Sequence[Any], index: int) -> Any:
    return values[index] if index < len(values) else None


def to_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return round(float(value), 4)
    except (TypeError, ValueError):
        return None


def add_optional(params: Dict[str, Any], key: str, value: Any) -> None:
    if value is not None and value != "":
        params[key] = value


def env_value(name: str, default: Optional[str] = None) -> str:
    value = os.getenv(name)
    return value.strip() if value and value.strip() else default or ""


def env_int(name: str) -> Optional[int]:
    value = env_value(name)
    return int(value) if value else None


def env_bool(name: str, default: bool) -> bool:
    value = env_value(name)
    if not value:
        return default
    normalized = value.lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise RuntimeError(f"{name} must be true or false.")

