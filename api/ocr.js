const ALLOWED_IMAGE_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/jpg", "jpg"],
  ["image/webp", "webp"],
]);

const DEFAULT_MAX_IMAGE_BYTES = 3_500_000;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 75_000;

export default async function handler(request, response) {
  try {
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      return sendJson(response, 405, { error: "Method not allowed." });
    }

    const ocrServiceUrl = normalizeServiceUrl(process.env.OCR_SERVICE_URL);
    const ocrApiToken = process.env.OCR_API_TOKEN?.trim();
    if (!ocrServiceUrl || !ocrApiToken) {
      return sendJson(response, 500, { error: "OCR service is not configured." });
    }

    const body = await readJsonBody(request);
    const image = decodeDataUrlImage(body?.image, getMaxImageBytes());
    const payload = await callOcrService(ocrServiceUrl, ocrApiToken, image);

    return sendJson(response, 200, {
      text: typeof payload.text === "string" ? payload.text : "",
      confidence: typeof payload.confidence === "number" ? payload.confidence : null,
      lines: Array.isArray(payload.lines) ? payload.lines : [],
      elapsedMs: Number.isFinite(payload.elapsedMs) ? payload.elapsedMs : null,
    });
  } catch (error) {
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    return sendJson(response, statusCode, {
      error: error instanceof Error ? error.message : "Unexpected OCR API error.",
    });
  }
}

async function callOcrService(ocrServiceUrl, ocrApiToken, image) {
  const form = new FormData();
  form.append("file", new Blob([image.buffer], { type: image.mimeType }), `ocr.${image.extension}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getUpstreamTimeoutMs());

  try {
    const ocrResponse = await fetch(`${ocrServiceUrl}/ocr`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ocrApiToken}`,
      },
      body: form,
      signal: controller.signal,
    });

    const payload = await readResponseJson(ocrResponse);
    if (!ocrResponse.ok) {
      const error = new Error(getUpstreamErrorMessage(ocrResponse.status, payload));
      error.statusCode = toProxyStatusCode(ocrResponse.status);
      throw error;
    }

    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("OCR service timed out.");
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function decodeDataUrlImage(value, maxBytes) {
  if (typeof value !== "string") {
    const error = new Error("image must be a data URL.");
    error.statusCode = 400;
    throw error;
  }

  const match = value.match(/^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    const error = new Error("Only png, jpg, jpeg, and webp data URLs are supported.");
    error.statusCode = 400;
    throw error;
  }

  const mimeType = match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase();
  const extension = ALLOWED_IMAGE_TYPES.get(mimeType);
  if (!extension) {
    const error = new Error("Unsupported image format.");
    error.statusCode = 400;
    throw error;
  }

  const base64 = match[2].replace(/\s+/g, "");
  if (base64.length % 4 === 1) {
    const error = new Error("Invalid base64 image payload.");
    error.statusCode = 400;
    throw error;
  }

  const estimatedBytes = Math.floor((base64.length * 3) / 4);
  if (estimatedBytes > maxBytes) {
    const error = new Error("Image is too large after OCR preprocessing.");
    error.statusCode = 413;
    throw error;
  }

  const buffer = Buffer.from(base64, "base64");
  if (buffer.length === 0 || buffer.length > maxBytes) {
    const error = new Error("Image is too large after OCR preprocessing.");
    error.statusCode = buffer.length === 0 ? 400 : 413;
    throw error;
  }

  return { buffer, mimeType, extension };
}

function getUpstreamErrorMessage(statusCode, payload) {
  if (statusCode === 401 || statusCode === 403) {
    return "OCR service authentication failed.";
  }
  if (statusCode === 413) {
    return "Image is too large for OCR service.";
  }
  if (statusCode === 429 || statusCode === 503 || statusCode === 504) {
    return "OCR service is busy. Please try again later.";
  }
  if (typeof payload?.detail === "string") {
    return payload.detail;
  }
  if (typeof payload?.error === "string") {
    return payload.error;
  }
  return "OCR service request failed.";
}

function toProxyStatusCode(statusCode) {
  if (statusCode === 400 || statusCode === 413) {
    return statusCode;
  }
  if (statusCode === 429 || statusCode === 503 || statusCode === 504) {
    return 503;
  }
  return 502;
}

async function readResponseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function normalizeServiceUrl(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : "";
}

function getMaxImageBytes() {
  return readPositiveInteger(process.env.OCR_PROXY_MAX_BYTES, DEFAULT_MAX_IMAGE_BYTES);
}

function getUpstreamTimeoutMs() {
  return readPositiveInteger(process.env.OCR_PROXY_TIMEOUT_MS, DEFAULT_UPSTREAM_TIMEOUT_MS);
}

function readPositiveInteger(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

async function readJsonBody(request) {
  if (typeof request.body === "string") {
    return request.body ? JSON.parse(request.body) : {};
  }
  if (Buffer.isBuffer(request.body)) {
    const rawBody = request.body.toString("utf8");
    return rawBody ? JSON.parse(rawBody) : {};
  }
  if (request.body && typeof request.body === "object" && !isReadableStream(request.body)) {
    return request.body;
  }

  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function isReadableStream(value) {
  return typeof value?.getReader === "function";
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}
