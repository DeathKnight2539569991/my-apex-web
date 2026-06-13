FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PADDLE_OCR_DEVICE=cpu

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends libglib2.0-0 libgl1 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./

ARG PADDLE_INDEX=https://www.paddlepaddle.org.cn/packages/stable/cpu/
RUN python -m pip install --upgrade pip \
    && python -m pip install --no-cache-dir paddlepaddle -i ${PADDLE_INDEX} \
    && python -m pip install --no-cache-dir -r requirements.txt

COPY server ./server
COPY scripts ./scripts

EXPOSE 8765

CMD ["python", "-m", "uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8765"]

