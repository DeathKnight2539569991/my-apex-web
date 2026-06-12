import { useEffect, useRef, useState, type MutableRefObject } from "react";

type ScreenCaptureDockProps = {
  onRecognizeImage: (file: File) => void;
};

type CaptureStatus = "idle" | "starting" | "capturing" | "error";

type CapturedScreenshot = {
  id: string;
  file: File;
  previewUrl: string;
  hash: string;
  capturedAt: number;
  score: number;
  width: number;
  height: number;
};

type Region = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

type RegionMetrics = {
  brightRatio: number;
  darkRatio: number;
  orangeRatio: number;
  edgeRatio: number;
};

type FrameAnalysis = {
  isCandidate: boolean;
  score: number;
  hash: string;
  reason: string;
};

const SAMPLE_INTERVAL_MS = 1500;
const CAPTURE_COOLDOWN_MS = 105_000;
const COOLDOWN_SECONDS = Math.round(CAPTURE_COOLDOWN_MS / 1000);
const MAX_SCREENSHOTS = 18;
const ANALYSIS_WIDTH = 480;
const REQUIRED_CANDIDATE_FRAMES = 2;
const HASH_GRID_SIZE = 16;
const DUPLICATE_HASH_DISTANCE = 22;

export default function ScreenCaptureDock({ onRecognizeImage }: ScreenCaptureDockProps) {
  const [status, setStatus] = useState<CaptureStatus>("idle");
  const [message, setMessage] = useState("自动捕获只在本浏览器会话暂存截图，不会自动保存云端。");
  const [screenSourceName, setScreenSourceName] = useState("");
  const [screenshots, setScreenshots] = useState<CapturedScreenshot[]>([]);
  const [lastScore, setLastScore] = useState<number | null>(null);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const screenshotsRef = useRef<CapturedScreenshot[]>([]);
  const lastCaptureAtRef = useRef(0);
  const candidateFramesRef = useRef(0);
  const isSamplingRef = useRef(false);
  const isCapturingRef = useRef(false);

  useEffect(() => {
    screenshotsRef.current = screenshots;
  }, [screenshots]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.srcObject = null;
      }
      revokeScreenshots(screenshotsRef.current);
    };
  }, []);

  async function startCapture() {
    if (status === "starting" || status === "capturing") {
      return;
    }

    if (!navigator.mediaDevices?.getDisplayMedia) {
      setStatus("error");
      setMessage("当前浏览器不支持屏幕共享捕获，请使用支持 getDisplayMedia 的现代浏览器。");
      return;
    }

    setStatus("starting");
    setMessage("请选择 Apex 窗口或整个屏幕。授权只会由浏览器弹出一次。");

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 4, max: 8 },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      const video = videoRef.current;
      if (!video) {
        throw new Error("捕获预览容器还没有准备好。");
      }

      streamRef.current = stream;
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();

      const [track] = stream.getVideoTracks();
      if (track) {
        setScreenSourceName(track.label || "共享画面");
        track.addEventListener("ended", handleSharedTrackEnded, { once: true });
      }

      isCapturingRef.current = true;
      candidateFramesRef.current = 0;
      setStatus("capturing");
      setMessage("正在自动扫描疑似 Apex 结算/战绩界面。捕获后会冷却约 105 秒。");
      startSampleTimer();
      void sampleCurrentFrame();
    } catch (error) {
      stopActiveStream();
      setStatus("error");
      setMessage(getCaptureErrorMessage(error));
    }
  }

  function stopCapture() {
    stopActiveStream();
    setStatus("idle");
    setMessage("已停止捕获。本次截图仍只保留在当前页面会话里。");
  }

  function handleSharedTrackEnded() {
    stopCapture();
  }

  function startSampleTimer() {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
    }

    timerRef.current = window.setInterval(() => {
      void sampleCurrentFrame();
    }, SAMPLE_INTERVAL_MS);
  }

  function stopActiveStream() {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }

    isCapturingRef.current = false;
    isSamplingRef.current = false;
    candidateFramesRef.current = 0;
    setScreenSourceName("");
    setCooldownSeconds(0);
  }

  async function sampleCurrentFrame() {
    if (isSamplingRef.current || !isCapturingRef.current) {
      return;
    }

    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      return;
    }

    const cooldownMs = getRemainingCooldownMs(lastCaptureAtRef.current);
    if (cooldownMs > 0) {
      setCooldownSeconds(Math.ceil(cooldownMs / 1000));
      setMessage(`已捕获截图，冷却中，约 ${Math.ceil(cooldownMs / 1000)} 秒后继续扫描。`);
      return;
    }

    setCooldownSeconds(0);
    isSamplingRef.current = true;

    try {
      const analysis = analyzeCurrentFrame(video, analysisCanvasRef);
      if (!analysis) {
        return;
      }

      setLastScore(analysis.score);
      if (!analysis.isCandidate) {
        candidateFramesRef.current = Math.max(0, candidateFramesRef.current - 1);
        setMessage("捕获运行中，尚未发现稳定的疑似结算/战绩界面。");
        return;
      }

      candidateFramesRef.current += 1;
      if (candidateFramesRef.current < REQUIRED_CANDIDATE_FRAMES) {
        setMessage(`发现疑似战绩界面，正在二次确认：${analysis.reason}`);
        return;
      }

      candidateFramesRef.current = 0;
      await captureCandidateFrame(video, analysis);
    } finally {
      isSamplingRef.current = false;
    }
  }

  async function captureCandidateFrame(video: HTMLVideoElement, analysis: FrameAnalysis) {
    if (screenshotsRef.current.length >= MAX_SCREENSHOTS) {
      setMessage(`本次已暂存 ${MAX_SCREENSHOTS} 张截图，已达到上限。请先识别、删除或清空。`);
      return;
    }

    const duplicate = screenshotsRef.current.some(
      (screenshot) => hammingDistance(screenshot.hash, analysis.hash) <= DUPLICATE_HASH_DISTANCE,
    );
    if (duplicate) {
      setMessage("同一画面已经在待确认列表中，已跳过重复截图。");
      return;
    }

    const canvas = getCanvas(captureCanvasRef);
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = get2dContext(canvas);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await canvasToBlob(canvas);
    const file = new File([blob], createCaptureFileName(), {
      type: "image/png",
      lastModified: Date.now(),
    });
    const screenshot: CapturedScreenshot = {
      id: createId(),
      file,
      previewUrl: URL.createObjectURL(file),
      hash: analysis.hash,
      capturedAt: Date.now(),
      score: analysis.score,
      width: canvas.width,
      height: canvas.height,
    };

    setScreenshots((current) => {
      const next = [screenshot, ...current].slice(0, MAX_SCREENSHOTS);
      screenshotsRef.current = next;
      return next;
    });
    lastCaptureAtRef.current = Date.now();
    setCooldownSeconds(COOLDOWN_SECONDS);
    setMessage(`已自动捕获 1 张疑似战绩截图，进入约 ${COOLDOWN_SECONDS} 秒冷却。`);
  }

  function recognizeScreenshot(screenshot: CapturedScreenshot) {
    onRecognizeImage(screenshot.file);
    setMessage(`已把 ${screenshot.file.name} 加入现有 OCR 识别流程。`);
  }

  function deleteScreenshot(id: string) {
    setScreenshots((current) => {
      const target = current.find((screenshot) => screenshot.id === id);
      if (target) {
        URL.revokeObjectURL(target.previewUrl);
      }

      const next = current.filter((screenshot) => screenshot.id !== id);
      screenshotsRef.current = next;
      return next;
    });
  }

  function clearScreenshots() {
    setScreenshots((current) => {
      revokeScreenshots(current);
      screenshotsRef.current = [];
      return [];
    });
    setMessage("已清空本次自动捕获的待确认截图。");
  }

  const isCaptureActive = status === "starting" || status === "capturing";
  const captureLabel =
    status === "starting" ? "等待授权" : status === "capturing" ? "捕获中" : status === "error" ? "异常" : "未捕获";

  return (
    <section className="screen-capture-dock" aria-labelledby="screen-capture-title">
      <div className="screen-capture-heading">
        <div>
          <p className="eyebrow">Auto Capture</p>
          <h3 id="screen-capture-title">浏览器自动捕获战绩截图</h3>
        </div>
        <span className={`capture-badge ${status}`}>{captureLabel}</span>
      </div>

      <div className="capture-actions">
        <button type="button" className="primary-button compact" disabled={isCaptureActive} onClick={startCapture}>
          开始自动捕获
        </button>
        <button type="button" className="ghost-button" disabled={!isCaptureActive} onClick={stopCapture}>
          停止捕获
        </button>
        <button type="button" className="ghost-button danger" disabled={screenshots.length === 0} onClick={clearScreenshots}>
          清空本次捕获
        </button>
      </div>

      <div className={`capture-status ${status}`} role="status" aria-live="polite">
        <span>{message}</span>
        <small>
          {screenSourceName ? `${screenSourceName} · ` : ""}
          {lastScore === null ? "未分析" : `疑似度 ${lastScore.toFixed(1)}`}
          {cooldownSeconds > 0 ? ` · 冷却 ${cooldownSeconds}s` : ""}
        </small>
      </div>

      <video ref={videoRef} className="capture-video" muted playsInline aria-hidden="true" />

      <div className="capture-list-heading">
        <h4>本次自动捕获到的截图列表</h4>
        <span>
          {screenshots.length}/{MAX_SCREENSHOTS}
        </span>
      </div>

      {screenshots.length === 0 ? (
        <div className="capture-empty">停止捕获后，疑似战绩截图会留在这里等待你统一确认。</div>
      ) : (
        <div className="capture-shot-list">
          {screenshots.map((screenshot) => (
            <article className="capture-shot-card" key={screenshot.id}>
              <img src={screenshot.previewUrl} alt="自动捕获的 Apex 疑似战绩截图" />
              <div className="capture-shot-meta">
                <strong>{new Date(screenshot.capturedAt).toLocaleTimeString("zh-CN", { hour12: false })}</strong>
                <span>
                  {screenshot.width}x{screenshot.height} · 疑似度 {screenshot.score.toFixed(1)}
                </span>
              </div>
              <div className="capture-shot-actions">
                <button type="button" className="ghost-button" onClick={() => recognizeScreenshot(screenshot)}>
                  识别这张
                </button>
                <button type="button" className="ghost-button danger" onClick={() => deleteScreenshot(screenshot.id)}>
                  删除
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function analyzeCurrentFrame(
  video: HTMLVideoElement,
  canvasRef: MutableRefObject<HTMLCanvasElement | null>,
): FrameAnalysis | null {
  const canvas = getCanvas(canvasRef);
  const targetWidth = Math.min(ANALYSIS_WIDTH, video.videoWidth);
  const targetHeight = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * targetWidth));
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const context = get2dContext(canvas);
  context.drawImage(video, 0, 0, targetWidth, targetHeight);
  const imageData = context.getImageData(0, 0, targetWidth, targetHeight);
  const stats = inspectApexResultFrame(imageData);

  return {
    ...stats,
    hash: createAverageHash(imageData),
  };
}

function inspectApexResultFrame(imageData: ImageData) {
  const { width, height } = imageData;
  const leftPanel = createRegion(width, height, 0, 0.08, 0.48, 0.94);
  const topBand = createRegion(width, height, 0.04, 0, 0.96, 0.24);
  const centerPanel = createRegion(width, height, 0.28, 0.18, 0.9, 0.9);
  const leftMetrics = measureRegion(imageData, leftPanel);
  const topMetrics = measureRegion(imageData, topBand);
  const centerMetrics = measureRegion(imageData, centerPanel);
  const textRows = countTextRows(imageData, leftPanel);

  let score = 0;
  const reasons: string[] = [];

  if (leftMetrics.darkRatio > 0.32) {
    score += 0.8;
    reasons.push("暗色结算背景");
  }
  if (leftMetrics.brightRatio > 0.014 && leftMetrics.brightRatio < 0.22) {
    score += 1.1;
    reasons.push("左侧文字密度");
  }
  if (leftMetrics.orangeRatio > 0.0018 || topMetrics.orangeRatio > 0.0015) {
    score += 1.1;
    reasons.push("Apex 橙色 UI");
  }
  if (leftMetrics.edgeRatio > 0.045 && leftMetrics.edgeRatio < 0.34) {
    score += 1.1;
    reasons.push("数据栏边缘");
  }
  if (textRows >= 7) {
    score += 1.4;
    reasons.push("多行战绩文本");
  }
  if (topMetrics.brightRatio > 0.012 || topMetrics.orangeRatio > 0.0015) {
    score += 0.7;
    reasons.push("顶部标题区域");
  }
  if (centerMetrics.edgeRatio > 0.03 && centerMetrics.brightRatio > 0.006) {
    score += 0.7;
    reasons.push("结算面板结构");
  }

  const isCandidate = score >= 4.7 && textRows >= 6 && leftMetrics.brightRatio > 0.01;
  return {
    isCandidate,
    score: Math.round(score * 10) / 10,
    reason: reasons.slice(0, 3).join(" / ") || "像素特征接近",
  };
}

function createRegion(width: number, height: number, x0: number, y0: number, x1: number, y1: number): Region {
  return {
    x0: Math.floor(width * x0),
    y0: Math.floor(height * y0),
    x1: Math.floor(width * x1),
    y1: Math.floor(height * y1),
  };
}

function measureRegion(imageData: ImageData, region: Region): RegionMetrics {
  const { data, width } = imageData;
  const step = 2;
  let total = 0;
  let bright = 0;
  let dark = 0;
  let orange = 0;
  let edges = 0;

  for (let y = region.y0; y < region.y1; y += step) {
    for (let x = region.x0; x < region.x1; x += step) {
      const offset = (y * width + x) * 4;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const luminance = getLuminance(red, green, blue);
      const isOrange = isApexOrange(red, green, blue);
      const isCyan = green > 130 && blue > 120 && red < 130;

      total += 1;
      if (luminance > 178 || isOrange || isCyan) {
        bright += 1;
      }
      if (luminance < 64) {
        dark += 1;
      }
      if (isOrange) {
        orange += 1;
      }
      if (x + step < region.x1) {
        const nextOffset = (y * width + x + step) * 4;
        const nextLuminance = getLuminance(data[nextOffset], data[nextOffset + 1], data[nextOffset + 2]);
        if (Math.abs(luminance - nextLuminance) > 52) {
          edges += 1;
        }
      }
    }
  }

  return {
    brightRatio: total === 0 ? 0 : bright / total,
    darkRatio: total === 0 ? 0 : dark / total,
    orangeRatio: total === 0 ? 0 : orange / total,
    edgeRatio: total === 0 ? 0 : edges / total,
  };
}

function countTextRows(imageData: ImageData, region: Region) {
  const rows = 34;
  let hits = 0;

  for (let row = 0; row < rows; row += 1) {
    const rowRegion = {
      x0: region.x0,
      x1: region.x1,
      y0: Math.floor(region.y0 + ((region.y1 - region.y0) * row) / rows),
      y1: Math.floor(region.y0 + ((region.y1 - region.y0) * (row + 1)) / rows),
    };
    const metrics = measureRegion(imageData, rowRegion);

    if (metrics.brightRatio > 0.008 && metrics.brightRatio < 0.24 && metrics.edgeRatio > 0.018) {
      hits += 1;
    }
  }

  return hits;
}

function createAverageHash(imageData: ImageData) {
  const { data, width, height } = imageData;
  const cells: number[] = [];

  for (let gy = 0; gy < HASH_GRID_SIZE; gy += 1) {
    for (let gx = 0; gx < HASH_GRID_SIZE; gx += 1) {
      const x0 = Math.floor((gx * width) / HASH_GRID_SIZE);
      const x1 = Math.floor(((gx + 1) * width) / HASH_GRID_SIZE);
      const y0 = Math.floor((gy * height) / HASH_GRID_SIZE);
      const y1 = Math.floor(((gy + 1) * height) / HASH_GRID_SIZE);
      let sum = 0;
      let total = 0;

      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const offset = (y * width + x) * 4;
          sum += getLuminance(data[offset], data[offset + 1], data[offset + 2]);
          total += 1;
        }
      }

      cells.push(total === 0 ? 0 : sum / total);
    }
  }

  const average = cells.reduce((total, value) => total + value, 0) / cells.length;
  return cells.map((value) => (value >= average ? "1" : "0")).join("");
}

function getLuminance(red: number, green: number, blue: number) {
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function isApexOrange(red: number, green: number, blue: number) {
  return red > 145 && green > 48 && green < 190 && blue < 135 && red > blue * 1.35;
}

function hammingDistance(left: string, right: string) {
  if (left.length !== right.length) {
    return Number.POSITIVE_INFINITY;
  }

  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      distance += 1;
    }
  }
  return distance;
}

function getCanvas(canvasRef: MutableRefObject<HTMLCanvasElement | null>) {
  if (!canvasRef.current) {
    canvasRef.current = document.createElement("canvas");
  }
  return canvasRef.current;
}

function get2dContext(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("当前浏览器无法创建 canvas 上下文。");
  }
  return context;
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error("截图生成失败。"));
    }, "image/png");
  });
}

function getRemainingCooldownMs(lastCaptureAt: number) {
  const nextCaptureAt = lastCaptureAt + CAPTURE_COOLDOWN_MS;
  return Math.max(0, nextCaptureAt - Date.now());
}

function createCaptureFileName() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `apex-auto-capture-${timestamp}.png`;
}

function createId() {
  if ("randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getCaptureErrorMessage(error: unknown) {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "你取消了屏幕共享授权，自动捕获没有启动。";
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "启动屏幕共享失败。";
}

function revokeScreenshots(screenshots: CapturedScreenshot[]) {
  screenshots.forEach((screenshot) => URL.revokeObjectURL(screenshot.previewUrl));
}
