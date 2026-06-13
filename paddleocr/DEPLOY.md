# Apex OCR server deployment

This is the simple deployment path for a fresh Linux server that only has Python.
All OCR files live in one directory: `/opt/apex-ocr`.

## 1. Check Python and systemd

```bash
python3 --version
python3 -m pip --version || true
systemctl --version
```

If `pip` or `venv` is missing on Ubuntu/Debian:

```bash
apt update
apt install -y python3-pip python3-venv curl
```

PaddleOCR often needs these runtime libraries on a minimal server:

```bash
apt install -y libglib2.0-0 libgl1 libgomp1
```

## 2. Create the app directory

```bash
mkdir -p /opt/apex-ocr
cd /opt/apex-ocr
```

Copy these two files into `/opt/apex-ocr`:

```text
app.py
requirements.txt
```

## 3. Create requirements.txt

```bash
cat > /opt/apex-ocr/requirements.txt <<'EOF'
fastapi
uvicorn[standard]
python-multipart
pillow
numpy
paddleocr
EOF
```

## 4. Create a virtual environment

```bash
cd /opt/apex-ocr
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install paddlepaddle -i https://www.paddlepaddle.org.cn/packages/stable/cpu/
python -m pip install -r requirements.txt
```

The first OCR request may be slow because PaddleOCR downloads models.

## 5. Create the service env file

Generate a token:

```bash
python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(48))
PY
```

Create `/opt/apex-ocr/.env`:

```bash
cat > /opt/apex-ocr/.env <<'EOF'
OCR_API_TOKEN=replace_with_the_generated_token
OCR_MAX_BYTES=10485760
OCR_QUEUE_TIMEOUT_SECONDS=60
PADDLE_OCR_DEVICE=cpu
PADDLE_OCR_ENABLE_MKLDNN=false
EOF
```

Keep this token private. The same value must be configured in Vercel as `OCR_API_TOKEN`.

## 6. Test manually before systemd

```bash
cd /opt/apex-ocr
source .venv/bin/activate
set -a
. ./.env
set +a
python -m uvicorn app:app --host 0.0.0.0 --port 24321
```

Open another SSH terminal and test:

```bash
curl http://127.0.0.1:24321/health

curl -X POST http://127.0.0.1:24321/ocr \
  -H "Authorization: Bearer replace_with_the_generated_token" \
  -F "file=@/path/to/test.png"
```

Stop the manual server with `Ctrl+C` after the test succeeds.

## 7. Configure systemd

Create `/etc/systemd/system/apex-ocr.service`:

```bash
cat > /etc/systemd/system/apex-ocr.service <<'EOF'
[Unit]
Description=Apex PaddleOCR HTTP Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/apex-ocr
EnvironmentFile=/opt/apex-ocr/.env
ExecStart=/opt/apex-ocr/.venv/bin/python -m uvicorn app:app --host 0.0.0.0 --port 24321 --workers 1
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

Start and enable it:

```bash
systemctl daemon-reload
systemctl enable --now apex-ocr
systemctl status apex-ocr
```

View logs:

```bash
journalctl -u apex-ocr -f
```

Restart after changing `.env` or `app.py`:

```bash
systemctl restart apex-ocr
```

## 8. Open the firewall

If you use `ufw`:

```bash
ufw allow 24321/tcp
```

If your cloud provider has a security group/firewall panel, open TCP port `24321`.
If it can restrict source IPs, allow only Vercel's outbound IPs if your plan/network setup gives you fixed ones.

## 9. Configure Vercel

In the Vercel project settings, add these environment variables for Production:

```env
OCR_SERVICE_URL=http://your_server_public_ip:24321
OCR_API_TOKEN=the_same_token_from_/opt/apex-ocr/.env
```

Optional:

```env
OCR_PROXY_MAX_BYTES=3500000
OCR_PROXY_TIMEOUT_MS=75000
```

Redeploy the Vercel site after changing environment variables.

## 10. Production checks

From your local machine:

```bash
curl http://your_server_public_ip:24321/health
curl -X POST http://your_server_public_ip:24321/ocr \
  -H "Authorization: Bearer the_same_token" \
  -F "file=@test.png"
```

Then open your website and upload a screenshot. The browser should call only `/api/ocr`.
It should not show `OCR_API_TOKEN` or the OCR server URL in browser network requests.

