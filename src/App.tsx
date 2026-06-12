import { useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import backgroundImage from "../6b68b6d7-178e-4bdc-9f5c-ed94e82b894b.png";
import type { CloudDataResponse, HistoryMetrics, MatchDraft, MatchRecord, PlayerMetricsEntry, ZoneScore } from "./types";
import { deleteCloudMatch, deleteCloudPlayer, fetchCloudData, saveCloudMatch } from "./lib/cloud";
import { formatDuration, formatNumber, formatPercent, parseDurationToSeconds, parseNumber } from "./lib/format";
import { calculateHistoryMetrics, calculateSingleMatchMetrics, calculateZoneScore } from "./lib/metrics";
import { extractMatchDraftFromText, recognizeImage } from "./lib/ocr";
import ScreenCaptureDock from "./components/ScreenCaptureDock";

const emptyDraft: MatchDraft = {
  playerId: "",
  kills: "",
  assists: "",
  knocks: "",
  damage: "",
  survivalTime: "",
};

const emptySiteMetrics = calculateHistoryMetrics([]);

type OcrState = {
  status: "idle" | "reading" | "done" | "error";
  message: string;
  progress: number;
};

type QueuedImage = {
  id: string;
  file: File;
};

type CloudState = {
  status: "idle" | "loading" | "ready" | "saving" | "error";
  message: string;
};

export default function App() {
  const [draft, setDraft] = useState<MatchDraft>(emptyDraft);
  const [matches, setMatches] = useState<MatchRecord[]>([]);
  const [players, setPlayers] = useState<string[]>([]);
  const [playerMetrics, setPlayerMetrics] = useState<PlayerMetricsEntry[]>([]);
  const [siteMetrics, setSiteMetrics] = useState<HistoryMetrics>(emptySiteMetrics);
  const [adminDeleteEnabled, setAdminDeleteEnabled] = useState(false);
  const [selectedPlayerId, setSelectedPlayerId] = useState("");
  const [queryPlayerId, setQueryPlayerId] = useState("");
  const [imagePreview, setImagePreview] = useState("");
  const [processedPreview, setProcessedPreview] = useState("");
  const [ocrRawText, setOcrRawText] = useState("");
  const [sourceImageName, setSourceImageName] = useState("");
  const [imageQueue, setImageQueue] = useState<QueuedImage[]>([]);
  const [cloudState, setCloudState] = useState<CloudState>({
    status: "idle",
    message: "正在连接云端数据...",
  });
  const [ocrState, setOcrState] = useState<OcrState>({
    status: "idle",
    message: "上传截图后会自动尝试识别，推荐只截左侧数据栏。",
    progress: 0,
  });

  useEffect(() => {
    void loadCloudData("");
  }, []);

  useEffect(() => {
    function handlePaste(event: ClipboardEvent) {
      const files = getClipboardImageFiles(event);
      if (files.length === 0) {
        return;
      }

      event.preventDefault();
      enqueueImages(files);
    }

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  });

  const activePlayerId = selectedPlayerId || queryPlayerId.trim() || draft.playerId.trim();
  const activeMatches = matches;
  const latestMatch = activeMatches.length > 0 ? activeMatches[activeMatches.length - 1] : null;
  const latestMetrics = latestMatch ? calculateSingleMatchMetrics(latestMatch) : null;
  const historyMetrics = useMemo(() => calculateHistoryMetrics(activeMatches), [activeMatches]);
  const latestZoneScore = useMemo(
    () => (latestMatch ? calculateZoneScore(calculateHistoryMetrics([latestMatch]), siteMetrics) : null),
    [latestMatch, siteMetrics],
  );
  const historyZoneScore = useMemo(
    () => calculateZoneScore(historyMetrics, siteMetrics, { playerId: activePlayerId, playerMetrics }),
    [activePlayerId, historyMetrics, playerMetrics, siteMetrics],
  );
  const recentMatches = useMemo(() => activeMatches.slice(-10).reverse(), [activeMatches]);
  const validationError = validateDraft(draft);

  async function loadCloudData(playerId: string) {
    const trimmedPlayerId = playerId.trim();
    setCloudState({
      status: "loading",
      message: trimmedPlayerId ? `正在查询 ${trimmedPlayerId} 的云端档案...` : "正在同步云端玩家列表和网站平均...",
    });

    try {
      const payload = await fetchCloudData(trimmedPlayerId || undefined);
      applyCloudPayload(payload, trimmedPlayerId);
      setCloudState({
        status: "ready",
        message: trimmedPlayerId
          ? `已加载 ${trimmedPlayerId}：${payload.matches.length} 局记录。`
          : `云端已连接：${payload.players.length} 名玩家，${payload.siteMetrics.matchCount} 局全站样本。`,
      });
    } catch (error) {
      setCloudState({
        status: "error",
        message: error instanceof Error ? error.message : "云端连接失败。",
      });
    }
  }

  function applyCloudPayload(payload: CloudDataResponse, preferredPlayerId: string) {
    setMatches(payload.matches);
    setPlayers(payload.players);
    setPlayerMetrics(payload.playerMetrics);
    setSiteMetrics(payload.siteMetrics);
    setAdminDeleteEnabled(Boolean(payload.adminDeleteEnabled));

    if (preferredPlayerId) {
      setSelectedPlayerId(preferredPlayerId);
      setQueryPlayerId(preferredPlayerId);
    }
  }

  function handlePlayerSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void loadCloudData(queryPlayerId);
  }

  function handlePlayerSelect(playerId: string) {
    setQueryPlayerId(playerId);
    void loadCloudData(playerId);
  }

  function updateDraft(field: keyof MatchDraft, value: string) {
    setDraft((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function enqueueImages(files: Iterable<File>) {
    const images = Array.from(files).filter(isImageFile);
    if (images.length === 0) {
      return;
    }

    const queuedImages = images.map((file) => ({
      id: createId(),
      file,
    }));

    if (hasActiveImage()) {
      setImageQueue((current) => [...current, ...queuedImages]);
      return;
    }

    const [nextImage, ...remainingImages] = queuedImages;
    setImageQueue((current) => [...current, ...remainingImages]);
    void processImage(nextImage.file);
  }

  function hasActiveImage() {
    return Boolean(sourceImageName || imagePreview || processedPreview || ocrRawText || ocrState.status === "reading");
  }

  function advanceToNextQueuedImage() {
    const nextImage = imageQueue[0];
    if (!nextImage) {
      return false;
    }

    setImageQueue((current) => current.slice(1));
    setDraft((current) => ({ ...emptyDraft, playerId: current.playerId }));
    void processImage(nextImage.file);
    return true;
  }

  async function processImage(file: File) {
    setSourceImageName(file.name);
    setImagePreview((current) => {
      if (current) {
        URL.revokeObjectURL(current);
      }

      return URL.createObjectURL(file);
    });
    setProcessedPreview("");
    setOcrRawText("");
    setOcrState({
      status: "reading",
      message: "正在识别截图文字...",
      progress: 0,
    });

    try {
      const result = await recognizeImage(file, ({ status, progress }) => {
        setOcrState({
          status: "reading",
          message: translateOcrStatus(status),
          progress,
        });
      });
      const extracted = extractMatchDraftFromText(result.text);

      setProcessedPreview(result.processedImageUrl);
      setOcrRawText(result.text.trim());
      setDraft((current) => ({
        ...current,
        ...removeEmptyValues(removePlayerId(extracted)),
      }));
      setOcrState({
        status: "done",
        message: "识别完成，已优先处理左侧数据栏，请校对后再保存。",
        progress: 1,
      });
    } catch {
      setOcrState({
        status: "error",
        message: "OCR 没读出来，直接手动填写也能用。",
        progress: 0,
      });
    }
  }

  async function handleSubmit() {
    if (validationError) {
      return;
    }

    const record = draftToRecord(draft, sourceImageName);
    setCloudState({
      status: "saving",
      message: `正在把 ${record.playerId} 的这局数据保存到云端...`,
    });

    try {
      const payload = await saveCloudMatch(record);
      applyCloudPayload(payload, record.playerId);
      setCloudState({
        status: "ready",
        message: `已保存到云端：${record.playerId} 现在有 ${payload.matches.length} 局记录。`,
      });
      if (!advanceToNextQueuedImage()) {
        clearImageInput({ preservePlayerId: true, clearQueue: false });
      }
    } catch (error) {
      setCloudState({
        status: "error",
        message: error instanceof Error ? error.message : "保存到云端失败。",
      });
    }
  }

  function handleResetDraft() {
    clearImageInput({ preservePlayerId: false, clearQueue: true });
  }

  function clearImageInput({
    preservePlayerId,
    clearQueue,
  }: {
    preservePlayerId: boolean;
    clearQueue: boolean;
  }) {
    setDraft((current) => (preservePlayerId ? { ...emptyDraft, playerId: current.playerId } : emptyDraft));
    setImagePreview((current) => {
      if (current) {
        URL.revokeObjectURL(current);
      }

      return "";
    });
    setProcessedPreview("");
    setOcrRawText("");
    setSourceImageName("");
    if (clearQueue) {
      setImageQueue([]);
    }
    setOcrState({
      status: "idle",
      message: "上传截图后会自动尝试识别，推荐只截左侧数据栏。",
      progress: 0,
    });
  }

  async function handleClearPlayerHistory() {
    if (!activePlayerId) {
      return;
    }

    if (!adminDeleteEnabled) {
      setCloudState({
        status: "error",
        message: "服务器未配置 ADMIN_DELETE_TOKEN，整档删除已禁用。",
      });
      return;
    }

    const confirmed = window.confirm(`确定删除 ${activePlayerId} 的整个玩家档案吗？这会移除该玩家全部单局记录。`);
    if (!confirmed) {
      return;
    }

    const adminToken = window.prompt("请输入管理员口令以删除整个玩家档案：");
    if (adminToken === null) {
      return;
    }

    const trimmedToken = adminToken.trim();
    if (!trimmedToken) {
      setCloudState({
        status: "error",
        message: "管理员口令不能为空。",
      });
      return;
    }

    setCloudState({
      status: "saving",
      message: `正在删除 ${activePlayerId} 的云端档案...`,
    });

    try {
      const payload = await deleteCloudPlayer(activePlayerId, trimmedToken);
      applyCloudPayload(payload, "");
      setSelectedPlayerId("");
      setQueryPlayerId("");
      setCloudState({
        status: "ready",
        message: `已删除 ${activePlayerId} 的云端档案。`,
      });
    } catch (error) {
      setCloudState({
        status: "error",
        message: error instanceof Error ? error.message : "删除云端档案失败。",
      });
    }
  }

  async function handleDeleteMatch(match: MatchRecord) {
    const matchTime = new Date(match.createdAt).toLocaleString("zh-CN");
    const confirmed = window.confirm(`确定删除 ${matchTime} 的这局记录吗？`);
    if (!confirmed) {
      return;
    }

    setCloudState({
      status: "saving",
      message: `正在删除 ${match.playerId} 的单局记录...`,
    });

    try {
      const payload = await deleteCloudMatch(match.playerId, match.id);
      applyCloudPayload(payload, payload.matches.length > 0 ? match.playerId : "");
      if (payload.matches.length === 0) {
        setSelectedPlayerId("");
        setQueryPlayerId(match.playerId);
      }
      setCloudState({
        status: "ready",
        message: `已删除 ${match.playerId} 的 1 局记录，剩余 ${payload.matches.length} 局。`,
      });
    } catch (error) {
      setCloudState({
        status: "error",
        message: error instanceof Error ? error.message : "删除单局记录失败。",
      });
    }
  }

  return (
    <main
      className="app-shell"
      style={{ "--app-background": `url(${backgroundImage})` } as CSSProperties & Record<"--app-background", string>}
    >
      <div className="content-frame">
        <header className="topbar">
          <div>
            <p className="eyebrow">Apex 数据画像实验室</p>
            <h1>谁是区😋</h1>
          </div>
          <div className="topbar-stats" aria-label="云端数据概览">
            <span>{activeMatches.length} 当前样本</span>
            <span>{siteMetrics.matchCount} 全站样本</span>
            <span>{players.length} 名云端玩家</span>
          </div>
        </header>

        <form className="cloud-search" onSubmit={handlePlayerSearch}>
          <label className="field">
            <span>通过玩家 ID 查询云端档案</span>
            <input
              value={queryPlayerId}
              placeholder="例如 DK 或 [POM] SangJoon"
              onChange={(event) => setQueryPlayerId(event.target.value)}
            />
          </label>
          <button type="submit" className="primary-button compact" disabled={cloudState.status === "loading"}>
            查询
          </button>
          <select value={selectedPlayerId} onChange={(event) => handlePlayerSelect(event.target.value)}>
            <option value="">云端玩家列表</option>
            {players.map((player) => (
              <option key={player} value={player}>
                {player}
              </option>
            ))}
          </select>
        </form>

        <div className={`cloud-status ${cloudState.status}`}>{cloudState.message}</div>

        <section className="workspace-grid">
          <section className="panel input-panel" aria-labelledby="input-title">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Panel 01</p>
                <h2 id="input-title">截图提取与校对</h2>
              </div>
              <button type="button" className="ghost-button" onClick={handleResetDraft}>
                清空
              </button>
            </div>

            <label className="upload-zone">
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={(event) => {
                  enqueueImages(event.currentTarget.files ?? []);
                  event.currentTarget.value = "";
                }}
              />
              {imagePreview ? (
                <img src={imagePreview} alt="上传的 Apex 数据截图预览" />
              ) : (
                <span>上传中文 Apex 数据截图，推荐只截左侧数据栏</span>
              )}
            </label>

            {imageQueue.length > 0 ? (
              <div className="queue-status">待处理图片：{imageQueue.length} 张。保存当前校准后会自动进入下一张，也可以直接粘贴图片加入队列。</div>
            ) : null}

            <ScreenCaptureDock onRecognizeImage={(file) => enqueueImages([file])} />

            <div className={`ocr-status ${ocrState.status}`}>
              <span>{ocrState.message}</span>
              {ocrState.status === "reading" ? <strong>{Math.round(ocrState.progress * 100)}%</strong> : null}
            </div>

            {processedPreview || ocrRawText ? (
              <details className="ocr-debug">
                <summary>识别调试：预处理图片与 OCR 原文</summary>
                {processedPreview ? <img src={processedPreview} alt="OCR 预处理后的左侧数据栏" /> : null}
                <pre>{ocrRawText || "OCR 没有读到文本。"}</pre>
              </details>
            ) : null}

            <div className="form-grid">
              <label className="field full">
                <span>玩家 ID</span>
                <input
                  value={draft.playerId}
                  placeholder="[POM] SangJoon"
                  onChange={(event) => updateDraft("playerId", event.target.value)}
                />
              </label>
              <label className="field">
                <span>击杀</span>
                <input value={draft.kills} inputMode="numeric" onChange={(event) => updateDraft("kills", event.target.value)} />
              </label>
              <label className="field">
                <span>助攻</span>
                <input
                  value={draft.assists}
                  inputMode="numeric"
                  onChange={(event) => updateDraft("assists", event.target.value)}
                />
              </label>
              <label className="field">
                <span>击倒</span>
                <input value={draft.knocks} inputMode="numeric" onChange={(event) => updateDraft("knocks", event.target.value)} />
              </label>
              <label className="field">
                <span>伤害量</span>
                <input
                  value={draft.damage}
                  inputMode="numeric"
                  placeholder="5,522"
                  onChange={(event) => updateDraft("damage", event.target.value)}
                />
              </label>
              <label className="field">
                <span>存活时间</span>
                <input
                  value={draft.survivalTime}
                  placeholder="20:13"
                  onChange={(event) => updateDraft("survivalTime", event.target.value)}
                />
              </label>
            </div>

            {validationError ? <p className="form-error">{validationError}</p> : null}

            <button
              type="button"
              className="primary-button"
              disabled={Boolean(validationError) || cloudState.status === "saving" || ocrState.status === "reading"}
              onClick={handleSubmit}
            >
              保存到云端
            </button>
          </section>

          <section className="panel report-panel" aria-labelledby="report-title">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Panel 02</p>
                <h2 id="report-title">单局指标报告</h2>
              </div>
            </div>
            {latestMatch && latestMetrics ? (
              <>
                <div className="player-strip">
                  <span>{latestMatch.playerId}</span>
                  <small>{new Date(latestMatch.createdAt).toLocaleString("zh-CN")}</small>
                </div>
                <div className="metric-grid">
                  <MetricCard label="分时伤害 DPM" value={formatNumber(latestMetrics.dpm, 1)} hint="伤害 / 存活分钟" />
                  <MetricCard
                    label="伤害人头比"
                    value={latestMetrics.damagePerKill === null ? "无效伤害" : formatNumber(latestMetrics.damagePerKill, 1)}
                    hint="伤害 / 击杀"
                  />
                  <MetricCard label="击倒转化率" value={formatPercent(latestMetrics.knockConversionRate, 1)} hint="击杀 / 击倒" />
                  <MetricCard label="纯击倒" value={String(latestMetrics.pureKnocks)} hint="击倒 - 击杀" />
                </div>
                {latestZoneScore ? <ZoneScoreCard title="本局区值评分" zoneScore={latestZoneScore} /> : null}
              </>
            ) : (
              <EmptyState title="还没有单局报告" body="先查询玩家档案，或上传截图保存一局云端数据。" />
            )}
          </section>
        </section>

        <section className="panel history-panel" aria-labelledby="history-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Panel 03</p>
              <h2 id="history-title">个人历史档案</h2>
            </div>
            <button
              type="button"
              className="ghost-button danger"
              disabled={!activePlayerId || !adminDeleteEnabled}
              title={adminDeleteEnabled ? "需要管理员口令" : "服务器未配置 ADMIN_DELETE_TOKEN，整档删除已禁用"}
              onClick={handleClearPlayerHistory}
            >
              删除该玩家云端档案
            </button>
          </div>

          {activeMatches.length > 0 ? (
            <>
              <ZoneScoreCard title="历史区值评分" zoneScore={historyZoneScore} />

              <div className="summary-grid">
                <MetricCard label="场均伤害" value={formatNumber(historyMetrics.avgDamage, 1)} hint="全部历史" />
                <MetricCard label="场均击杀" value={formatNumber(historyMetrics.avgKills, 2)} hint="全部历史" />
                <MetricCard label="场均助攻" value={formatNumber(historyMetrics.avgAssists, 2)} hint="全部历史" />
                <MetricCard label="场均击倒" value={formatNumber(historyMetrics.avgKnocks, 2)} hint="全部历史" />
                <MetricCard label="场均存活" value={formatDuration(historyMetrics.avgSurvivalSeconds)} hint="全部历史" />
                <MetricCard
                  label="伤害稳定性"
                  value={historyMetrics.damageStability === null ? "样本不足" : formatNumber(historyMetrics.damageStability, 1)}
                  hint="至少 3 局"
                />
              </div>

              <div className="efficiency-strip">
                <MetricPill label="历史 DPM" value={formatNumber(historyMetrics.historicalDpm, 1)} />
                <MetricPill
                  label="历史伤害人头比"
                  value={
                    historyMetrics.historicalDamagePerKill === null
                      ? "无效伤害"
                      : formatNumber(historyMetrics.historicalDamagePerKill, 1)
                  }
                />
                <MetricPill label="历史击倒转化率" value={formatPercent(historyMetrics.historicalKnockConversionRate, 1)} />
              </div>

              <div className="chart-grid">
                <ChartPanel title="近期状态波动">
                  <ReactECharts option={createTrendOption(activeMatches)} className="chart" notMerge />
                </ChartPanel>
                <ChartPanel title="个人 vs 网站平均">
                  <ReactECharts option={createRadarOption(historyMetrics, siteMetrics, activePlayerId)} className="chart" notMerge />
                </ChartPanel>
                <RadarNotes playerMetrics={historyMetrics} siteMetrics={siteMetrics} />
              </div>

              <RecentMatchesList
                matches={recentMatches}
                onDeleteMatch={handleDeleteMatch}
                isDeleting={cloudState.status === "saving"}
              />
            </>
          ) : (
            <EmptyState title="这个 ID 暂无云端档案" body="输入玩家 ID 查询，或保存一局数据后自动创建该玩家档案。" />
          )}
        </section>
      </div>
    </main>
  );
}

function MetricCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </article>
  );
}

function MetricPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-pill">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ChartPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="chart-panel">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

function ZoneScoreCard({ title, zoneScore }: { title: string; zoneScore: ZoneScore }) {
  const highlightedComponents = zoneScore.components
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  return (
    <section className="zone-score-card" aria-label={title}>
      <div className="zone-score-main">
        <div>
          <span>{title}</span>
          <strong>{zoneScore.score}</strong>
          <small>/ 100</small>
        </div>
        <b>{zoneScore.title}</b>
      </div>
      <p>{zoneScore.explanation}</p>
      {zoneScore.sampleWarning ? <small className="zone-score-warning">{zoneScore.sampleWarning}</small> : null}
      {highlightedComponents.length > 0 ? (
        <div className="zone-score-components" aria-label="区值评分主要加分项">
          {highlightedComponents.map((component) => (
            <span key={component.label}>
              {component.label}评分 {component.score}/100
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function RecentMatchesList({
  matches,
  onDeleteMatch,
  isDeleting,
}: {
  matches: MatchRecord[];
  onDeleteMatch: (match: MatchRecord) => void | Promise<void>;
  isDeleting: boolean;
}) {
  return (
    <section className="recent-matches" aria-labelledby="recent-matches-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Match Log</p>
          <h3 id="recent-matches-title">最近对局</h3>
        </div>
        <span>最多显示最近 10 局</span>
      </div>

      <div className="match-list">
        {matches.map((match) => (
          <article className="match-row" key={match.id}>
            <time dateTime={match.createdAt}>{new Date(match.createdAt).toLocaleString("zh-CN")}</time>
            <dl className="match-stats">
              <div>
                <dt>伤害</dt>
                <dd>{formatNumber(match.damage)}</dd>
              </div>
              <div>
                <dt>击杀</dt>
                <dd>{match.kills}</dd>
              </div>
              <div>
                <dt>助攻</dt>
                <dd>{match.assists}</dd>
              </div>
              <div>
                <dt>击倒</dt>
                <dd>{match.knocks}</dd>
              </div>
              <div>
                <dt>存活</dt>
                <dd>{formatDuration(match.survivalSeconds)}</dd>
              </div>
            </dl>
            <button
              type="button"
              className="ghost-button danger match-delete-button"
              disabled={isDeleting}
              onClick={() => void onDeleteMatch(match)}
            >
              删除单局
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function RadarNotes({ playerMetrics, siteMetrics }: { playerMetrics: HistoryMetrics; siteMetrics: HistoryMetrics }) {
  return (
    <div className="radar-notes">
      <h3>雷达原始值</h3>
      <div className="radar-table">
        <RadarRow label="场均伤害" player={formatNumber(playerMetrics.avgDamage, 1)} site={formatNumber(siteMetrics.avgDamage, 1)} />
        <RadarRow label="场均击杀" player={formatNumber(playerMetrics.avgKills, 2)} site={formatNumber(siteMetrics.avgKills, 2)} />
        <RadarRow
          label="场均存活"
          player={formatDuration(playerMetrics.avgSurvivalSeconds)}
          site={formatDuration(siteMetrics.avgSurvivalSeconds)}
        />
        <RadarRow label="场均击倒" player={formatNumber(playerMetrics.avgKnocks, 2)} site={formatNumber(siteMetrics.avgKnocks, 2)} />
        <RadarRow
          label="终结转化"
          player={formatPercent(playerMetrics.historicalKnockConversionRate, 1)}
          site={formatPercent(siteMetrics.historicalKnockConversionRate, 1)}
        />
        <RadarRow
          label="输出稳定"
          player={playerMetrics.damageStability === null ? "样本不足" : formatNumber(playerMetrics.damageStability, 1)}
          site={siteMetrics.damageStability === null ? "样本不足" : formatNumber(siteMetrics.damageStability, 1)}
        />
      </div>
    </div>
  );
}

function RadarRow({ label, player, site }: { label: string; player: string; site: string }) {
  return (
    <div className="radar-row">
      <span>{label}</span>
      <strong>{player}</strong>
      <small>{site}</small>
    </div>
  );
}

function validateDraft(draft: MatchDraft) {
  if (!draft.playerId.trim()) {
    return "需要玩家 ID。";
  }

  const numericFields: Array<[keyof MatchDraft, string]> = [
    ["kills", "击杀"],
    ["assists", "助攻"],
    ["knocks", "击倒"],
    ["damage", "伤害量"],
  ];

  for (const [field, label] of numericFields) {
    const value = parseNumber(draft[field]);
    if (!Number.isInteger(value) || value < 0) {
      return `${label} 必须是非负整数。`;
    }
  }

  const survivalSeconds = parseDurationToSeconds(draft.survivalTime);
  if (!Number.isFinite(survivalSeconds) || survivalSeconds <= 0) {
    return "存活时间需要是 20:13 这种格式，且必须大于 0。";
  }

  return "";
}

function draftToRecord(draft: MatchDraft, sourceImageName?: string): MatchRecord {
  return {
    id: createId(),
    playerId: draft.playerId.trim(),
    kills: parseNumber(draft.kills),
    assists: parseNumber(draft.assists),
    knocks: parseNumber(draft.knocks),
    damage: parseNumber(draft.damage),
    survivalSeconds: parseDurationToSeconds(draft.survivalTime),
    createdAt: new Date().toISOString(),
    sourceImageName,
  };
}

function createId() {
  if ("randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function removeEmptyValues(draft: Partial<MatchDraft>) {
  return Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== ""));
}

function removePlayerId(draft: Partial<MatchDraft>) {
  const draftWithoutPlayerId = { ...draft };
  delete draftWithoutPlayerId.playerId;
  return draftWithoutPlayerId;
}

function isImageFile(file: File) {
  return file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name);
}

function getClipboardImageFiles(event: ClipboardEvent) {
  const clipboardData = event.clipboardData;
  if (!clipboardData) {
    return [];
  }

  const files = Array.from(clipboardData.files).filter(isImageFile);
  if (files.length > 0) {
    return files;
  }

  return Array.from(clipboardData.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
    .filter(isImageFile);
}

function translateOcrStatus(status: string) {
  const statusMap: Record<string, string> = {
    "loading tesseract core": "正在加载 OCR 引擎...",
    "initializing tesseract": "正在初始化 OCR...",
    "loading language traineddata": "正在加载中英文识别模型...",
    "initializing api": "正在准备识别...",
    "recognizing text": "正在识别截图文字...",
  };

  return statusMap[status] ?? status;
}

function createTrendOption(matches: MatchRecord[]): EChartsOption {
  const recentMatches = matches.slice(-10);

  return {
    color: ["#ff8b54", "#5de0e6"],
    tooltip: { trigger: "axis" },
    legend: {
      top: 0,
      textStyle: { color: "#fff3e2" },
    },
    grid: { top: 48, left: 48, right: 18, bottom: 38 },
    xAxis: {
      type: "category",
      data: recentMatches.map((_, index) => `第 ${Math.max(matches.length - recentMatches.length + index + 1, 1)} 局`),
      axisLabel: { color: "#cbbba8" },
      axisLine: { lineStyle: { color: "#4a3b34" } },
    },
    yAxis: [
      {
        type: "value",
        name: "伤害",
        axisLabel: { color: "#cbbba8" },
        splitLine: { lineStyle: { color: "rgba(224, 210, 190, 0.13)" } },
      },
      {
        type: "value",
        name: "击杀",
        axisLabel: { color: "#cbbba8" },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: "伤害",
        type: "line",
        smooth: true,
        data: recentMatches.map((match) => match.damage),
      },
      {
        name: "击杀",
        type: "line",
        yAxisIndex: 1,
        smooth: true,
        data: recentMatches.map((match) => match.kills),
      },
    ],
  };
}

function createRadarOption(playerMetrics: HistoryMetrics, siteMetrics: HistoryMetrics, playerId: string): EChartsOption {
  const rows = createRadarRows(playerMetrics, siteMetrics);
  const playerValues = rows.map((row) => normalizeRadarValue(row.player, row.max));
  const siteValues = rows.map((row) => normalizeRadarValue(row.site, row.max));

  return {
    color: ["#ff8b54", "#5de0e6"],
    tooltip: {
      formatter: () => createRadarTooltip(rows, playerId),
    },
    legend: {
      top: 0,
      textStyle: { color: "#fff3e2" },
    },
    radar: {
      center: ["50%", "55%"],
      radius: "62%",
      splitNumber: 2,
      indicator: rows.map((row) => ({ name: row.name, max: 100 })),
      axisName: { color: "#fff3e2", fontSize: 12 },
      splitArea: { show: false },
      splitLine: { lineStyle: { color: ["rgba(224, 210, 190, 0.22)", "rgba(224, 210, 190, 0.38)"] } },
      axisLine: { lineStyle: { color: "rgba(224, 210, 190, 0.14)" } },
    },
    series: [
      {
        type: "radar",
        symbolSize: 5,
        areaStyle: { opacity: 0.18 },
        lineStyle: { width: 2 },
        data: [
          {
            value: playerValues,
            name: playerId || "当前玩家",
          },
          {
            value: siteValues,
            name: "网站平均",
            areaStyle: { opacity: 0.08 },
            lineStyle: { type: "dashed", width: 2 },
          },
        ],
      },
    ],
  };
}

function createRadarRows(playerMetrics: HistoryMetrics, siteMetrics: HistoryMetrics) {
  const playerFinish = (playerMetrics.historicalKnockConversionRate ?? 0) * 100;
  const siteFinish = (siteMetrics.historicalKnockConversionRate ?? 0) * 100;
  const playerStability = playerMetrics.damageStability ?? 0;
  const siteStability = siteMetrics.damageStability ?? 0;

  return [
    createRadarRow("场均伤害", playerMetrics.avgDamage, siteMetrics.avgDamage, 500, (value) => formatNumber(value, 1)),
    createRadarRow("场均击杀", playerMetrics.avgKills, siteMetrics.avgKills, 1, (value) => formatNumber(value, 2)),
    createRadarRow(
      "场均存活",
      playerMetrics.avgSurvivalSeconds / 60,
      siteMetrics.avgSurvivalSeconds / 60,
      10,
      (value) => `${formatNumber(value, 1)} 分`,
    ),
    createRadarRow("场均击倒", playerMetrics.avgKnocks, siteMetrics.avgKnocks, 2, (value) => formatNumber(value, 2)),
    createRadarRow("终结转化", playerFinish, siteFinish, 100, (value) => `${formatNumber(value, 1)}%`, true),
    createRadarRow("输出稳定", playerStability, siteStability, 100, (value) => `${formatNumber(value, 1)}`, true),
  ];
}

function createRadarRow(
  name: string,
  player: number,
  site: number,
  baseline: number,
  format: (value: number) => string,
  percentScale = false,
) {
  const max = percentScale ? 100 : Math.max(player, site, baseline) * 1.18;
  return { name, player, site, max, format };
}

function normalizeRadarValue(value: number, max: number) {
  if (max <= 0) {
    return 0;
  }
  return Math.min(Math.max((value / max) * 100, 0), 100);
}

function createRadarTooltip(rows: ReturnType<typeof createRadarRows>, playerId: string) {
  const header = `<strong>${playerId || "当前玩家"} vs 网站平均</strong>`;
  const body = rows
    .map((row) => `${row.name}: ${row.format(row.player)} / ${row.format(row.site)}`)
    .join("<br/>");
  return `${header}<br/>${body}`;
}
