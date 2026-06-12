import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type MutableRefObject,
  type PointerEvent,
} from "react";
import type { MatchDraft } from "../types";
import { extractMatchDraftFromText, recognizeImage } from "../lib/ocr";

type ScreenCaptureDockProps = {
  onFillForm: (file: File) => void;
};

type CaptureStatus = "idle" | "starting" | "capturing" | "error";
type CaptureRegionMode = "left" | "middle" | "right" | "full" | "custom";
type Sensitivity = "strict" | "normal" | "loose";

type CaptureRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CaptureSettings = {
  regionMode: CaptureRegionMode;
  region: CaptureRegion;
  sensitivity: Sensitivity;
};

type CapturedScreenshot = {
  id: string;
  file: File;
  previewUrl: string;
  capturedAt: number;
  confidence: number;
  width: number;
  height: number;
  regionLabel: string;
  summary: string;
};

type OcrConfidence = {
  score: number;
  matchedKeywords: string[];
  parsedFields: string[];
};

type RegionPoint = {
  x: number;
  y: number;
};

type PreviewSize = {
  width: number;
  height: number;
};

const SAMPLE_INTERVAL_MS = 1500;
const CAPTURE_COOLDOWN_MS = 120_000;
const COOLDOWN_SECONDS = Math.round(CAPTURE_COOLDOWN_MS / 1000);
const MAX_SCREENSHOTS = 18;
const SETTINGS_STORAGE_KEY = "apex:auto-capture-settings:v2";

const sensitivityThresholds: Record<Sensitivity, number> = {
  strict: 70,
  normal: 60,
  loose: 45,
};

const sensitivityLabels: Record<Sensitivity, string> = {
  strict: "严格 70",
  normal: "普通 60",
  loose: "宽松 45",
};

const regionLabels: Record<CaptureRegionMode, string> = {
  left: "左侧数据栏",
  middle: "中间数据栏",
  right: "右侧数据栏",
  full: "全屏",
  custom: "自定义区域",
};

const regionPresets: Record<Exclude<CaptureRegionMode, "custom">, CaptureRegion> = {
  left: { x: 0, y: 0, width: 0.35, height: 1 },
  middle: { x: 0.325, y: 0, width: 0.35, height: 1 },
  right: { x: 0.65, y: 0, width: 0.35, height: 1 },
  full: { x: 0, y: 0, width: 1, height: 1 },
};

const defaultSettings: CaptureSettings = {
  regionMode: "left",
  region: regionPresets.left,
  sensitivity: "normal",
};

const keywordPatterns: Array<[string, RegExp]> = [
  ["击杀", /击杀|擊殺|杀敌|擊败|击败|kill/i],
  ["助攻", /助攻|assist/i],
  ["击倒", /击倒|擊倒|knock/i],
  ["伤害", /造成伤害|造成傷害|伤害|傷害|damage/i],
  ["生存时间", /生存时间|存活时间|生存|存活|survival/i],
];

const draftFieldChecks: Array<[keyof MatchDraft, string, RegExp]> = [
  ["kills", "击杀", /^\d+$/],
  ["assists", "助攻", /^\d+$/],
  ["knocks", "击倒", /^\d+$/],
  ["damage", "伤害", /^\d[\d,]*$/],
  ["survivalTime", "生存时间", /^\d{1,2}:\d{2}(?::\d{2})?$/],
];

export default function ScreenCaptureDock({ onFillForm }: ScreenCaptureDockProps) {
  const [settings, setSettings] = useState<CaptureSettings>(() => readCaptureSettings());
  const [status, setStatus] = useState<CaptureStatus>("idle");
  const [message, setMessage] = useState("自动捕获只保存本地裁剪图，OCR 置信度达标后才加入待确认列表。");
  const [screenSourceName, setScreenSourceName] = useState("");
  const [screenshots, setScreenshots] = useState<CapturedScreenshot[]>([]);
  const [lastConfidence, setLastConfidence] = useState<number | null>(null);
  const [lastSummary, setLastSummary] = useState("还未检测");
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [isOcrChecking, setIsOcrChecking] = useState(false);
  const [selectionPreviewUrl, setSelectionPreviewUrl] = useState("");
  const [selectionPreviewSize, setSelectionPreviewSize] = useState<PreviewSize>({ width: 16, height: 9 });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const screenshotsRef = useRef<CapturedScreenshot[]>([]);
  const activeRegionRef = useRef<CaptureRegion>(getActiveRegion(settings));
  const settingsRef = useRef<CaptureSettings>(settings);
  const thresholdRef = useRef(sensitivityThresholds[settings.sensitivity]);
  const lastCaptureAtRef = useRef(0);
  const isSamplingRef = useRef(false);
  const isCapturingRef = useRef(false);
  const dragStartRef = useRef<RegionPoint | null>(null);
  const selectionPreviewUrlRef = useRef("");

  const activeRegion = useMemo(() => getActiveRegion(settings), [settings]);
  const threshold = sensitivityThresholds[settings.sensitivity];

  useEffect(() => {
    screenshotsRef.current = screenshots;
  }, [screenshots]);

  useEffect(() => {
    selectionPreviewUrlRef.current = selectionPreviewUrl;
  }, [selectionPreviewUrl]);

  useEffect(() => {
    settingsRef.current = settings;
    activeRegionRef.current = activeRegion;
    thresholdRef.current = threshold;
    writeCaptureSettings(settings);
  }, [activeRegion, settings, threshold]);

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
      if (selectionPreviewUrlRef.current) {
        URL.revokeObjectURL(selectionPreviewUrlRef.current);
      }
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
      setStatus("capturing");
      setMessage("捕获运行中：冷却外会裁剪所选区域并做 OCR，低置信度会直接丢弃。");
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
    setIsOcrChecking(false);
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
      const nextCooldownSeconds = Math.ceil(cooldownMs / 1000);
      setCooldownSeconds(nextCooldownSeconds);
      setMessage(`冷却中，约 ${nextCooldownSeconds} 秒后恢复检测。冷却期间不 OCR、不截图。`);
      return;
    }

    setCooldownSeconds(0);
    isSamplingRef.current = true;
    setIsOcrChecking(true);

    try {
      const currentSettings = settingsRef.current;
      const captured = await captureSelectedRegion(video, activeRegionRef.current, captureCanvasRef);
      setMessage(`正在 OCR 检测${regionLabels[currentSettings.regionMode]}，低于 ${thresholdRef.current} 分会丢弃。`);

      const result = await recognizeImage(captured.file, undefined, { cropMode: "none" });
      const confidence = calculateOcrConfidence(result.text);
      setLastConfidence(confidence.score);
      setLastSummary(formatConfidenceSummary(confidence));

      if (confidence.score < thresholdRef.current) {
        setMessage(`本帧 OCR 置信度 ${confidence.score}，低于 ${thresholdRef.current}，已丢弃。`);
        return;
      }

      addCapturedScreenshot(captured, confidence, currentSettings.regionMode);
    } catch (error) {
      if (isCapturingRef.current) {
        setMessage(error instanceof Error ? `本帧 OCR 检测失败：${error.message}` : "本帧 OCR 检测失败，继续等待下一帧。");
      }
    } finally {
      isSamplingRef.current = false;
      setIsOcrChecking(false);
    }
  }

  function addCapturedScreenshot(
    captured: Awaited<ReturnType<typeof captureSelectedRegion>>,
    confidence: OcrConfidence,
    regionMode: CaptureRegionMode,
  ) {
    if (screenshotsRef.current.length >= MAX_SCREENSHOTS) {
      setMessage(`本次已暂存 ${MAX_SCREENSHOTS} 张截图，已达到上限。请先填入表单、删除或清空。`);
      return;
    }

    const screenshot: CapturedScreenshot = {
      id: createId(),
      file: captured.file,
      previewUrl: URL.createObjectURL(captured.file),
      capturedAt: Date.now(),
      confidence: confidence.score,
      width: captured.width,
      height: captured.height,
      regionLabel: regionLabels[regionMode],
      summary: formatConfidenceSummary(confidence),
    };

    setScreenshots((current) => {
      const next = [screenshot, ...current].slice(0, MAX_SCREENSHOTS);
      screenshotsRef.current = next;
      return next;
    });
    lastCaptureAtRef.current = Date.now();
    setCooldownSeconds(COOLDOWN_SECONDS);
    setMessage(`OCR 置信度 ${confidence.score}，已加入待确认列表，进入 ${COOLDOWN_SECONDS} 秒冷却。`);
  }

  function fillFormFromScreenshot(screenshot: CapturedScreenshot) {
    onFillForm(screenshot.file);
    setMessage(`已把 ${screenshot.file.name} 送入现有 OCR 流程，自动捕获图不会二次裁剪。`);
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

  function handleRegionModeChange(event: ChangeEvent<HTMLSelectElement>) {
    const nextMode = toCaptureRegionMode(event.currentTarget.value);
    setSettings((current) => ({
      ...current,
      regionMode: nextMode,
      region: nextMode === "custom" ? current.region : regionPresets[nextMode],
    }));
  }

  function handleSensitivityChange(event: ChangeEvent<HTMLSelectElement>) {
    const sensitivity = toSensitivity(event.currentTarget.value);
    setSettings((current) => ({
      ...current,
      sensitivity,
    }));
  }

  function handleCustomRegionChange(field: keyof CaptureRegion, value: string) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
      return;
    }

    setSettings((current) => ({
      ...current,
      regionMode: "custom",
      region: normalizeRegion({
        ...current.region,
        [field]: numericValue / 100,
      }),
    }));
  }

  async function refreshSelectionPreview() {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      setMessage("请先点击“开始自动捕获”并选择 Apex 窗口或屏幕，再框选自定义区域。");
      return;
    }

    const canvas = getCanvas(previewCanvasRef);
    const previewWidth = Math.min(960, video.videoWidth);
    const previewHeight = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * previewWidth));
    canvas.width = previewWidth;
    canvas.height = previewHeight;

    const context = get2dContext(canvas);
    context.drawImage(video, 0, 0, previewWidth, previewHeight);

    const blob = await canvasToBlob(canvas);
    const previewUrl = URL.createObjectURL(blob);
    setSelectionPreviewUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current);
      }
      return previewUrl;
    });
    setSelectionPreviewSize({ width: previewWidth, height: previewHeight });
    setSettings((current) => ({
      ...current,
      regionMode: "custom",
      region: getActiveRegion(current),
    }));
    setMessage("已取样当前画面。请在预览图上拖拽框选你自己的数据栏区域。");
  }

  function closeSelectionPreview() {
    setSelectionPreviewUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current);
      }
      return "";
    });
    dragStartRef.current = null;
  }

  function handleRegionPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!selectionPreviewUrl) {
      return;
    }

    const point = getPointerRatio(event);
    dragStartRef.current = point;
    event.currentTarget.setPointerCapture(event.pointerId);
    applyRegionFromPoints(point, point);
  }

  function handleRegionPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!dragStartRef.current) {
      return;
    }

    applyRegionFromPoints(dragStartRef.current, getPointerRatio(event));
  }

  function handleRegionPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!dragStartRef.current) {
      return;
    }

    applyRegionFromPoints(dragStartRef.current, getPointerRatio(event));
    dragStartRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setMessage("自定义捕获区域已保存。自动捕获会只保存这个裁剪区域。");
  }

  function applyRegionFromPoints(start: RegionPoint, end: RegionPoint) {
    const nextRegion = normalizeRegion({
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    });

    setSettings((current) => ({
      ...current,
      regionMode: "custom",
      region: nextRegion,
    }));
  }

  const isCaptureActive = status === "starting" || status === "capturing";
  const canPickRegion = status === "capturing";
  const captureLabel =
    status === "starting" ? "等待授权" : status === "capturing" ? "捕获中" : status === "error" ? "异常" : "未捕获";
  const selectionBoxStyle = {
    left: `${activeRegion.x * 100}%`,
    top: `${activeRegion.y * 100}%`,
    width: `${activeRegion.width * 100}%`,
    height: `${activeRegion.height * 100}%`,
  } satisfies CSSProperties;
  const pickerStyle = {
    aspectRatio: `${selectionPreviewSize.width} / ${selectionPreviewSize.height}`,
  } satisfies CSSProperties;

  return (
    <section className="screen-capture-dock" aria-labelledby="screen-capture-title">
      <div className="screen-capture-heading">
        <div>
          <p className="eyebrow">Auto Capture</p>
          <h3 id="screen-capture-title">浏览器自动捕获战绩截图</h3>
        </div>
        <span className={`capture-badge ${status}`}>{captureLabel}</span>
      </div>

      <div className="capture-settings">
        <label className="capture-field">
          <span>捕获区域</span>
          <select value={settings.regionMode} onChange={handleRegionModeChange}>
            <option value="left">左侧数据栏</option>
            <option value="middle">中间数据栏</option>
            <option value="right">右侧数据栏</option>
            <option value="full">全屏</option>
            <option value="custom">自定义区域</option>
          </select>
        </label>
        <label className="capture-field">
          <span>OCR 灵敏度</span>
          <select value={settings.sensitivity} onChange={handleSensitivityChange}>
            <option value="strict">严格 70</option>
            <option value="normal">普通 60</option>
            <option value="loose">宽松 45</option>
          </select>
        </label>
      </div>

      {settings.regionMode === "custom" ? (
        <div className="capture-region-grid" aria-label="自定义捕获区域">
          <NumberField label="左" value={activeRegion.x} onChange={(value) => handleCustomRegionChange("x", value)} />
          <NumberField label="上" value={activeRegion.y} onChange={(value) => handleCustomRegionChange("y", value)} />
          <NumberField label="宽" value={activeRegion.width} onChange={(value) => handleCustomRegionChange("width", value)} />
          <NumberField label="高" value={activeRegion.height} onChange={(value) => handleCustomRegionChange("height", value)} />
        </div>
      ) : null}

      <div className="capture-region-tools">
        <button type="button" className="ghost-button" disabled={!canPickRegion} onClick={() => void refreshSelectionPreview()}>
          {selectionPreviewUrl ? "刷新画面预览" : "在当前画面上框选区域"}
        </button>
        {selectionPreviewUrl ? (
          <button type="button" className="ghost-button" onClick={closeSelectionPreview}>
            关闭框选预览
          </button>
        ) : null}
        <span>先开始自动捕获并授权屏幕，然后在预览图上拖拽选择自己的数据栏。</span>
      </div>

      {selectionPreviewUrl ? (
        <div
          className="capture-region-picker"
          style={pickerStyle}
          onPointerDown={handleRegionPointerDown}
          onPointerMove={handleRegionPointerMove}
          onPointerUp={handleRegionPointerUp}
          onPointerCancel={() => {
            dragStartRef.current = null;
          }}
          role="application"
          aria-label="拖拽框选自定义捕获区域"
        >
          <img src={selectionPreviewUrl} alt="用于框选捕获区域的当前共享画面预览" draggable={false} />
          <div className="capture-region-selection" style={selectionBoxStyle} />
        </div>
      ) : null}

      <div className="capture-region-readout">
        当前区域：x {formatRatio(activeRegion.x)} / y {formatRatio(activeRegion.y)} / w {formatRatio(activeRegion.width)} / h{" "}
        {formatRatio(activeRegion.height)}
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
          阈值 {threshold} · {lastConfidence === null ? "未 OCR" : `上次 OCR ${lastConfidence}`}
          {cooldownSeconds > 0 ? ` · 冷却 ${cooldownSeconds}s` : ""}
          {isOcrChecking ? " · 正在 OCR" : ""}
          {" · "}
          {lastSummary}
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
        <div className="capture-empty">达到 OCR 置信度阈值的裁剪截图会留在这里，赛后逐张填入表单。</div>
      ) : (
        <div className="capture-shot-list">
          {screenshots.map((screenshot) => (
            <article className="capture-shot-card" key={screenshot.id}>
              <img src={screenshot.previewUrl} alt="自动捕获的 Apex 裁剪战绩截图" />
              <div className="capture-shot-meta">
                <strong>{new Date(screenshot.capturedAt).toLocaleTimeString("zh-CN", { hour12: false })}</strong>
                <span>
                  {screenshot.regionLabel} · {screenshot.width}x{screenshot.height} · OCR {screenshot.confidence}
                </span>
              </div>
              <small className="capture-shot-summary">{screenshot.summary}</small>
              <div className="capture-shot-actions">
                <button type="button" className="ghost-button" onClick={() => fillFormFromScreenshot(screenshot)}>
                  填入表单
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

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: string) => void }) {
  return (
    <label className="capture-field compact">
      <span>{label}</span>
      <input min="0" max="100" step="1" type="number" value={toPercent(value)} onChange={(event) => onChange(event.currentTarget.value)} />
    </label>
  );
}

function getPointerRatio(event: PointerEvent<HTMLDivElement>): RegionPoint {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
    y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
  };
}

async function captureSelectedRegion(
  video: HTMLVideoElement,
  region: CaptureRegion,
  canvasRef: MutableRefObject<HTMLCanvasElement | null>,
) {
  const normalizedRegion = normalizeRegion(region);
  const sourceX = Math.round(video.videoWidth * normalizedRegion.x);
  const sourceY = Math.round(video.videoHeight * normalizedRegion.y);
  const sourceWidth = Math.max(1, Math.min(video.videoWidth - sourceX, Math.round(video.videoWidth * normalizedRegion.width)));
  const sourceHeight = Math.max(1, Math.min(video.videoHeight - sourceY, Math.round(video.videoHeight * normalizedRegion.height)));
  const canvas = getCanvas(canvasRef);
  canvas.width = sourceWidth;
  canvas.height = sourceHeight;

  const context = get2dContext(canvas);
  context.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);

  const blob = await canvasToBlob(canvas);
  const file = new File([blob], createCaptureFileName(), {
    type: "image/png",
    lastModified: Date.now(),
  });

  return {
    file,
    width: sourceWidth,
    height: sourceHeight,
  };
}

function calculateOcrConfidence(text: string): OcrConfidence {
  const compactText = text.replace(/\s+/g, "");
  const draft = extractMatchDraftFromText(text);
  const matchedKeywords = keywordPatterns.filter(([, pattern]) => pattern.test(compactText)).map(([label]) => label);
  const parsedFields = draftFieldChecks
    .filter(([field, , pattern]) => {
      const value = draft[field];
      return typeof value === "string" && pattern.test(value.trim());
    })
    .map(([, label]) => label);
  const score = Math.min(100, matchedKeywords.length * 6 + parsedFields.length * 14);

  return {
    score,
    matchedKeywords,
    parsedFields,
  };
}

function formatConfidenceSummary(confidence: OcrConfidence) {
  const keywords = confidence.matchedKeywords.length > 0 ? confidence.matchedKeywords.join("、") : "无关键词";
  const fields = confidence.parsedFields.length > 0 ? confidence.parsedFields.join("、") : "无字段";
  return `关键词：${keywords}；字段：${fields}`;
}

function getActiveRegion(settings: CaptureSettings) {
  return normalizeRegion(settings.regionMode === "custom" ? settings.region : regionPresets[settings.regionMode]);
}

function readCaptureSettings(): CaptureSettings {
  if (typeof window === "undefined") {
    return defaultSettings;
  }

  try {
    const rawSettings = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!rawSettings) {
      return defaultSettings;
    }

    const parsed = JSON.parse(rawSettings) as Partial<CaptureSettings>;
    const regionMode = toCaptureRegionMode(parsed.regionMode);
    const sensitivity = toSensitivity(parsed.sensitivity);
    const region = normalizeRegion(parsed.region ?? (regionMode === "custom" ? defaultSettings.region : regionPresets[regionMode]));

    return {
      regionMode,
      sensitivity,
      region: regionMode === "custom" ? region : regionPresets[regionMode],
    };
  } catch {
    return defaultSettings;
  }
}

function writeCaptureSettings(settings: CaptureSettings) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        regionMode: settings.regionMode,
        region: normalizeRegion(settings.region),
        sensitivity: settings.sensitivity,
      }),
    );
  } catch {
    // localStorage can be unavailable in private browsing modes.
  }
}

function toCaptureRegionMode(value: unknown): CaptureRegionMode {
  if (value === "left" || value === "middle" || value === "right" || value === "full" || value === "custom") {
    return value;
  }
  return "left";
}

function toSensitivity(value: unknown): Sensitivity {
  if (value === "strict" || value === "normal" || value === "loose") {
    return value;
  }
  return "normal";
}

function normalizeRegion(region: Partial<CaptureRegion>) {
  const x = clamp(readRatio(region.x, defaultSettings.region.x), 0, 0.98);
  const y = clamp(readRatio(region.y, defaultSettings.region.y), 0, 0.98);
  const width = clamp(readRatio(region.width, defaultSettings.region.width), 0.02, 1 - x);
  const height = clamp(readRatio(region.height, defaultSettings.region.height), 0.02, 1 - y);

  return {
    x,
    y,
    width,
    height,
  };
}

function readRatio(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function toPercent(value: number) {
  return Math.round(value * 100);
}

function formatRatio(value: number) {
  return value.toFixed(2);
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
