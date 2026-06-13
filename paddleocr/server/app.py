from __future__ import annotations

import base64
import binascii
import os
from typing import Any, Dict, List

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from server.engine import OcrOptions, get_engine_config, is_engine_loaded, recognize_image_bytes


def _get_cors_origins() -> List[str]:
    raw = os.getenv("PADDLE_OCR_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
    origins = [origin.strip() for origin in raw.split(",") if origin.strip()]
    return origins or ["http://localhost:5173", "http://127.0.0.1:5173"]


class Base64OcrRequest(BaseModel):
    image: str
    crop_mode: str = "stats-panel"
    preprocess: str = "none"
    upscale: bool = True


app = FastAPI(title="Apex PaddleOCR Service", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_get_cors_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "ok": True,
        "engineLoaded": is_engine_loaded(),
        "engine": get_engine_config(),
    }


@app.post("/ocr")
async def recognize_upload(
    file: UploadFile = File(...),
    crop_mode: str = Form("stats-panel"),
    preprocess: str = Form("none"),
    upscale: bool = Form(True),
) -> Dict[str, Any]:
    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    return await _recognize_or_error(image_bytes, OcrOptions(crop_mode=crop_mode, preprocess=preprocess, upscale=upscale))


@app.post("/ocr/base64")
async def recognize_base64(payload: Base64OcrRequest) -> Dict[str, Any]:
    image_bytes = _decode_base64_image(payload.image)
    return await _recognize_or_error(
        image_bytes,
        OcrOptions(crop_mode=payload.crop_mode, preprocess=payload.preprocess, upscale=payload.upscale),
    )


async def _recognize_or_error(image_bytes: bytes, options: OcrOptions) -> Dict[str, Any]:
    try:
        return await run_in_threadpool(recognize_image_bytes, image_bytes, options)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def _decode_base64_image(value: str) -> bytes:
    raw = value.split(",", 1)[1] if value.startswith("data:") and "," in value else value
    try:
        return base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=400, detail="image must be valid base64 or a data URL.") from exc
