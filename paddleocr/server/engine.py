from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import dataclass
from io import BytesIO
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np
from PIL import Image, UnidentifiedImageError


@dataclass(frozen=True)
class OcrOptions:
    crop_mode: str = "stats-panel"
    preprocess: str = "none"
    upscale: bool = True


_engine: Optional[Any] = None
_engine_lock = threading.Lock()
_engine_load_lock = threading.Lock()
_engine_config = None


def recognize_image_bytes(image_bytes: bytes, options: OcrOptions) -> Dict[str, Any]:
    if options.crop_mode not in {"stats-panel", "none"}:
        raise ValueError("crop_mode must be 'stats-panel' or 'none'.")
    if options.preprocess not in {"none", "binarize"}:
        raise ValueError("preprocess must be 'none' or 'binarize'.")

    started_at = time.perf_counter()
    source_image = _load_image(image_bytes)
    processed_image, crop, scale = _prepare_image(source_image, options)
    processed_array = np.asarray(processed_image)

    engine = get_engine()
    with _engine_lock:
        raw_result = _predict(engine, processed_array)

    lines = _normalize_result(raw_result, crop, scale)
    text = "\n".join(line["text"] for line in lines if line["text"])
    confidence = _average_confidence(lines)

    return {
        "text": text,
        "confidence": confidence,
        "lines": lines,
        "crop": crop,
        "source": {
            "width": source_image.width,
            "height": source_image.height,
        },
        "processed": {
            "width": processed_image.width,
            "height": processed_image.height,
            "scale": scale,
            "preprocess": options.preprocess,
        },
        "engine": get_engine_config(),
        "elapsedMs": round((time.perf_counter() - started_at) * 1000),
    }


def get_engine() -> Any:
    global _engine

    if _engine is not None:
        return _engine

    with _engine_load_lock:
        if _engine is None:
            _engine = _create_engine()
        return _engine


def is_engine_loaded() -> bool:
    return _engine is not None


def get_engine_config() -> Dict[str, Any]:
    config = _build_engine_config()
    return {
        "device": config["device"],
        "lang": config["lang"],
        "ocrVersion": config["ocr_version"],
        "engine": config["engine"],
        "textDetectionModelName": config["text_detection_model_name"],
        "textRecognitionModelName": config["text_recognition_model_name"],
        "cpuThreads": config["cpu_threads"],
        "enableMkldnn": config["enable_mkldnn"],
    }


def _create_engine() -> Any:
    try:
        from paddleocr import PaddleOCR
    except ImportError as exc:
        raise RuntimeError(
            "PaddleOCR is not installed or cannot be imported. "
            "Run this service from the paddleocr folder after installing requirements."
        ) from exc

    config = _build_engine_config()
    params: Dict[str, Any] = {
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
        "device": config["device"],
    }
    _add_optional(params, "lang", config["lang"])
    _add_optional(params, "ocr_version", config["ocr_version"])
    _add_optional(params, "engine", config["engine"])
    _add_optional(params, "text_detection_model_name", config["text_detection_model_name"])
    _add_optional(params, "text_recognition_model_name", config["text_recognition_model_name"])
    _add_optional(params, "cpu_threads", config["cpu_threads"])
    _add_optional(params, "enable_mkldnn", config["enable_mkldnn"])

    try:
        return PaddleOCR(**params)
    except TypeError:
        legacy_params: Dict[str, Any] = {
            "use_angle_cls": False,
            "lang": config["lang"] or "ch",
            "enable_mkldnn": config["enable_mkldnn"],
        }
        if config["device"] and config["device"].startswith("gpu"):
            legacy_params["use_gpu"] = True
        try:
            return PaddleOCR(**legacy_params)
        except TypeError:
            legacy_params.pop("enable_mkldnn", None)
            return PaddleOCR(**legacy_params)


def _build_engine_config() -> Dict[str, Any]:
    global _engine_config

    if _engine_config is not None:
        return _engine_config

    _engine_config = {
        "device": _env_value("PADDLE_OCR_DEVICE", "cpu"),
        "lang": _env_value("PADDLE_OCR_LANG"),
        "ocr_version": _env_value("PADDLE_OCR_VERSION"),
        "engine": _env_value("PADDLE_OCR_ENGINE"),
        "text_detection_model_name": _env_value("PADDLE_OCR_TEXT_DETECTION_MODEL_NAME"),
        "text_recognition_model_name": _env_value("PADDLE_OCR_TEXT_RECOGNITION_MODEL_NAME"),
        "cpu_threads": _env_int("PADDLE_OCR_CPU_THREADS"),
        "enable_mkldnn": _env_bool("PADDLE_OCR_ENABLE_MKLDNN", default=False),
    }
    return _engine_config


def _predict(engine: Any, image: np.ndarray) -> Any:
    if hasattr(engine, "predict"):
        return engine.predict(image)
    if hasattr(engine, "ocr"):
        return engine.ocr(image, cls=False)
    raise RuntimeError("Unsupported PaddleOCR engine object: missing predict() and ocr().")


def _load_image(image_bytes: bytes) -> Image.Image:
    try:
        return Image.open(BytesIO(image_bytes)).convert("RGB")
    except UnidentifiedImageError as exc:
        raise ValueError("The uploaded file is not a readable image.") from exc


def _prepare_image(image: Image.Image, options: OcrOptions) -> Tuple[Image.Image, Dict[str, int], float]:
    crop = _choose_crop(image.width, image.height, options.crop_mode)
    processed = image.crop((crop["x"], crop["y"], crop["x"] + crop["width"], crop["y"] + crop["height"]))

    scale = _choose_scale(crop["width"], options.crop_mode) if options.upscale else 1.0
    if scale != 1:
        resampling = getattr(getattr(Image, "Resampling", Image), "LANCZOS")
        processed = processed.resize((round(processed.width * scale), round(processed.height * scale)), resampling)

    if options.preprocess == "binarize":
        processed = _binarize(processed)

    return processed, crop, scale


def _choose_crop(width: int, height: int, crop_mode: str) -> Dict[str, int]:
    if crop_mode == "none":
        return {"x": 0, "y": 0, "width": width, "height": height}

    aspect = width / height if height else 1
    if aspect > 1.1:
        crop_ratio = 0.34
    elif aspect >= 0.62:
        crop_ratio = 0.49
    else:
        crop_ratio = 1

    return {
        "x": 0,
        "y": 0,
        "width": round(width * crop_ratio),
        "height": height,
    }


def _choose_scale(crop_width: int, crop_mode: str) -> float:
    if crop_mode == "none" and crop_width > 900:
        return 1.0
    if crop_width < 260:
        return 4.0
    if crop_width < 520:
        return 3.0
    return 2.0


def _binarize(image: Image.Image) -> Image.Image:
    rgb = np.asarray(image.convert("RGB"), dtype=np.float32)
    red = rgb[:, :, 0]
    green = rgb[:, :, 1]
    blue = rgb[:, :, 2]

    luminance = red * 0.299 + green * 0.587 + blue * 0.114
    orange_boost = np.where((red > 150) & (green > 55) & (red > blue * 1.35), red * 0.88, 0)
    gray = np.maximum(luminance, orange_boost).clip(0, 255).astype(np.uint8)
    threshold = min(max(_otsu_threshold(gray) + 8, 88), 176)
    binary = np.where(gray >= threshold, 0, 255).astype(np.uint8)
    return Image.fromarray(np.stack([binary, binary, binary], axis=-1), "RGB")


def _otsu_threshold(gray: np.ndarray) -> int:
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


def _normalize_result(raw_result: Any, crop: Dict[str, int], scale: float) -> List[Dict[str, Any]]:
    if isinstance(raw_result, list) and raw_result and _looks_like_legacy_result(raw_result):
        return _normalize_legacy_result(raw_result, crop, scale)

    lines: List[Dict[str, Any]] = []
    pages = raw_result if isinstance(raw_result, list) else [raw_result]
    for page in pages:
        page_data = _result_to_data_dict(page)
        texts = _to_sequence(page_data.get("rec_texts"))
        scores = _to_sequence(page_data.get("rec_scores"))
        boxes = _to_sequence(page_data.get("rec_boxes"))
        raw_polys = page_data.get("rec_polys")
        if raw_polys is None:
            raw_polys = page_data.get("dt_polys")
        polys = _to_sequence(raw_polys)

        for index, raw_text in enumerate(texts):
            text = str(raw_text).strip()
            if not text:
                continue

            score = _to_float(_item_at(scores, index))
            raw_box = _item_at(boxes, index)
            if raw_box is None:
                raw_box = _item_at(polys, index)
            processed_box = _make_box(raw_box)
            source_box = _map_box_to_source(processed_box, crop, scale) if processed_box else None
            lines.append(_make_line(text, score, source_box, processed_box))

    return lines


def _normalize_legacy_result(raw_result: Any, crop: Dict[str, int], scale: float) -> List[Dict[str, Any]]:
    lines: List[Dict[str, Any]] = []

    for item in _iter_legacy_items(raw_result):
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            continue

        raw_box = item[0]
        raw_recognition = item[1]
        if not isinstance(raw_recognition, (list, tuple)) or len(raw_recognition) < 2:
            continue

        text = str(raw_recognition[0]).strip()
        if not text:
            continue

        score = _to_float(raw_recognition[1])
        processed_box = _make_box(raw_box)
        source_box = _map_box_to_source(processed_box, crop, scale) if processed_box else None
        lines.append(_make_line(text, score, source_box, processed_box))

    return lines


def _looks_like_legacy_result(raw_result: List[Any]) -> bool:
    first = raw_result[0]
    if isinstance(first, (list, tuple)) and first and _looks_like_legacy_line(first[0]):
        return True
    return _looks_like_legacy_line(first)


def _looks_like_legacy_line(value: Any) -> bool:
    return (
        isinstance(value, (list, tuple))
        and len(value) >= 2
        and isinstance(value[1], (list, tuple))
        and len(value[1]) >= 2
    )


def _iter_legacy_items(raw_result: Any) -> Iterable[Any]:
    if isinstance(raw_result, (list, tuple)) and len(raw_result) == 1 and isinstance(raw_result[0], (list, tuple)):
        yield from raw_result[0]
        return
    yield from raw_result


def _result_to_data_dict(result: Any) -> Dict[str, Any]:
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

    if isinstance(payload, dict):
        nested = payload.get("res")
        return nested if isinstance(nested, dict) else payload

    if isinstance(payload, str):
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError:
            return {}
        if isinstance(parsed, dict):
            nested = parsed.get("res")
            return nested if isinstance(nested, dict) else parsed

    return {}


def _make_line(
    text: str,
    confidence: Optional[float],
    source_box: Optional[List[int]],
    processed_box: Optional[List[int]],
) -> Dict[str, Any]:
    return {
        "text": text,
        "confidence": confidence,
        "box": source_box,
        "processedBox": processed_box,
    }


def _make_box(raw_box: Any) -> Optional[List[int]]:
    box = _to_plain(raw_box)
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


def _map_box_to_source(box: Sequence[int], crop: Dict[str, int], scale: float) -> List[int]:
    return [
        round(box[0] / scale + crop["x"]),
        round(box[1] / scale + crop["y"]),
        round(box[2] / scale + crop["x"]),
        round(box[3] / scale + crop["y"]),
    ]


def _average_confidence(lines: Sequence[Dict[str, Any]]) -> Optional[float]:
    scores = [line["confidence"] for line in lines if isinstance(line.get("confidence"), (int, float))]
    if not scores:
        return None
    return round(float(sum(scores) / len(scores)), 4)


def _to_sequence(value: Any) -> List[Any]:
    if value is None:
        return []
    value = _to_plain(value)
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    return [value]


def _to_plain(value: Any) -> Any:
    if hasattr(value, "tolist"):
        value = value.tolist()
    if isinstance(value, tuple):
        return [_to_plain(item) for item in value]
    if isinstance(value, list):
        return [_to_plain(item) for item in value]
    if isinstance(value, np.generic):
        return value.item()
    return value


def _item_at(values: Sequence[Any], index: int) -> Any:
    return values[index] if index < len(values) else None


def _to_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return round(float(value), 4)
    except (TypeError, ValueError):
        return None


def _add_optional(params: Dict[str, Any], key: str, value: Any) -> None:
    if value is not None and value != "":
        params[key] = value


def _env_value(name: str, default: Optional[str] = None) -> Optional[str]:
    value = os.getenv(name)
    return value.strip() if value and value.strip() else default


def _env_int(name: str) -> Optional[int]:
    value = _env_value(name)
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        raise RuntimeError(f"{name} must be an integer.")


def _env_bool(name: str, default: bool) -> bool:
    value = _env_value(name)
    if value is None:
        return default
    normalized = value.lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise RuntimeError(f"{name} must be true or false.")
