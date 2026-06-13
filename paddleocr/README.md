# Apex PaddleOCR 本地服务

这个目录是一个独立的 PaddleOCR 测试服务。现在不会改主项目的 `src/lib/ocr.ts`；你先本地测识别效果，如果效果好，之后可以把前端 OCR 调用切到这里的 HTTP 接口。

接口合同：

- `GET /health`：健康检查。
- `POST /ocr`：上传图片，返回 `text`、平均 `confidence`、逐行 `lines`、裁剪信息。
- `POST /ocr/base64`：传 base64/data URL 图片，返回同样结构。

注意：请在 `paddleocr` 目录里面启动服务，因为当前目录名和第三方包 `paddleocr` 同名，从仓库根目录用 `uvicorn paddleocr...` 方式启动容易导入到本地目录。

## 本地安装

```powershell
cd "E:\Apex stats\paddleocr"
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip

# CPU 版推理引擎。GPU 环境请按 PaddlePaddle 官方安装页选择对应命令。
python -m pip install paddlepaddle -i https://www.paddlepaddle.org.cn/packages/stable/cpu/

python -m pip install -r requirements.txt
```

第一次识别会下载模型，可能会慢一些。

## 单图命令行测试

```powershell
python scripts\recognize_file.py "..\6b68b6d7-178e-4bdc-9f5c-ed94e82b894b.png" --crop-mode stats-panel
```

常用参数：

- `--crop-mode stats-panel`：默认，沿用现有前端逻辑，优先裁左侧数据栏。
- `--crop-mode none`：图片已经裁好时使用。
- `--preprocess binarize`：套用接近当前 Tesseract 流程的黑白阈值预处理；如果 Paddle 原图识别更好，就保持默认 `none`。
- `--no-upscale`：关闭小图自动放大。

## 启动 HTTP 服务

```powershell
python -m uvicorn server.app:app --host 127.0.0.1 --port 8765
```

健康检查：

```powershell
curl.exe http://127.0.0.1:8765/health
```

上传测试：

```powershell
curl.exe -X POST "http://127.0.0.1:8765/ocr" `
  -F "file=@..\6b68b6d7-178e-4bdc-9f5c-ed94e82b894b.png" `
  -F "crop_mode=stats-panel" `
  -F "preprocess=none"
```

返回示例：

```json
{
  "text": "击杀 / 助攻 / 击倒\n1 / 2 / 3\n造成伤害\n1234",
  "confidence": 0.91,
  "lines": [
    {
      "text": "造成伤害",
      "confidence": 0.96,
      "box": [12, 180, 166, 205],
      "processedBox": [24, 360, 332, 410]
    }
  ],
  "crop": { "x": 0, "y": 0, "width": 653, "height": 1080 },
  "source": { "width": 1920, "height": 1080 },
  "elapsedMs": 834
}
```

## 可选环境变量

```powershell
$env:PADDLE_OCR_DEVICE="cpu"          # 或 gpu:0
$env:PADDLE_OCR_LANG="ch"            # 默认不指定，使用 PaddleOCR 默认语言/模型
$env:PADDLE_OCR_VERSION="PP-OCRv6"   # 可改 PP-OCRv5/PP-OCRv4
$env:PADDLE_OCR_ENGINE="paddle_static"
$env:PADDLE_OCR_CPU_THREADS="8"
$env:PADDLE_OCR_ENABLE_MKLDNN="false" # 默认 false；遇到 oneDNN/PIR 报错时保持关闭
$env:PADDLE_OCR_CORS_ORIGINS="http://localhost:5173,http://127.0.0.1:5173"
```

也可以指定轻量或服务端模型：

```powershell
$env:PADDLE_OCR_TEXT_DETECTION_MODEL_NAME="PP-OCRv5_mobile_det"
$env:PADDLE_OCR_TEXT_RECOGNITION_MODEL_NAME="PP-OCRv5_mobile_rec"
```

## Docker 预留部署

```powershell
docker build -t apex-paddleocr .
docker run --rm -p 8765:8765 apex-paddleocr
```

服务端部署时建议把 `PADDLE_OCR_CORS_ORIGINS` 改成正式站点域名，并按机器情况选择 `PADDLE_OCR_DEVICE`。
