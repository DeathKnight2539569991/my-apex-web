import type { HistoryMetrics, MatchRecord, PlayerMetricsEntry, SingleMatchMetrics, ZoneScore, ZoneScoreComponent } from "../types";
import { clamp } from "./format";

const RADAR_LIMITS = {
  avgDamage: 1500,
  avgKills: 5,
  avgSurvivalMinutes: 20,
  avgKnocks: 7,
};

const ZONE_SCORE_BASELINES = {
  avgDamage: 500,
  historicalDpm: 80,
  avgKills: 1,
  avgAssists: 1,
  avgKnocks: 2,
  avgSurvivalSeconds: 600,
  knockConversionRate: 0.5,
  damageStability: 55,
};

const ZONE_SCORE_TITLES = ["伤害团队😭", "团队大腿🥵", "正常人类😀", "偶尔犯病😒", "究极大区🤣"];

type ZoneScoreRankingContext = {
  playerId: string;
  playerMetrics: PlayerMetricsEntry[];
};

export function calculateSingleMatchMetrics(match: MatchRecord): SingleMatchMetrics {
  const survivalMinutes = match.survivalSeconds / 60;
  const dpm = survivalMinutes > 0 ? match.damage / survivalMinutes : 0;
  const damagePerKill = match.kills > 0 ? match.damage / match.kills : null;
  const knockConversionRate = match.knocks > 0 ? match.kills / match.knocks : null;
  const pureKnocks = Math.max(match.knocks - match.kills, 0);

  return {
    survivalMinutes,
    dpm,
    damagePerKill,
    knockConversionRate,
    pureKnocks,
  };
}

export function calculateZoneScore(
  playerMetrics: HistoryMetrics,
  siteMetrics: HistoryMetrics,
  _rankingContext?: ZoneScoreRankingContext,
): ZoneScore {
  if (playerMetrics.matchCount === 0) {
    return {
      score: 0,
      title: "暂无评分",
      explanation: "还没有可用于计算评分的对局记录。",
      sampleWarning: null,
      components: [],
    };
  }

  const components = createZoneScoreComponents(playerMetrics, siteMetrics);
  const score = calculateZoneScoreValue(components);
  const strongest = [...components].sort((a, b) => b.score - a.score)[0];
  const weakest = [...components].sort((a, b) => a.score - b.score)[0];
  const sampleWarning =
    siteMetrics.matchCount === 0
      ? "网站平均暂无样本，当前评分使用基础基准临时估算。"
      : siteMetrics.matchCount < 5
        ? "网站平均样本偏少，评分会随着更多对局进入云端而更稳定。"
        : null;

  return {
    score,
    title: getZoneScoreTitle(score),
    explanation: createZoneScoreExplanation(score, strongest, weakest),
    sampleWarning,
    components,
  };
}

export function calculateHistoryMetrics(matches: MatchRecord[]): HistoryMetrics {
  const matchCount = matches.length;
  const totalDamage = sum(matches, (match) => match.damage);
  const totalKills = sum(matches, (match) => match.kills);
  const totalAssists = sum(matches, (match) => match.assists);
  const totalKnocks = sum(matches, (match) => match.knocks);
  const totalPureKnocks = sum(matches, (match) => calculateSingleMatchMetrics(match).pureKnocks);
  const totalSurvivalSeconds = sum(matches, (match) => match.survivalSeconds);
  const totalSurvivalMinutes = totalSurvivalSeconds / 60;

  const avgDamage = divide(totalDamage, matchCount);
  const avgKills = divide(totalKills, matchCount);
  const avgAssists = divide(totalAssists, matchCount);
  const avgKnocks = divide(totalKnocks, matchCount);
  const avgSurvivalSeconds = divide(totalSurvivalSeconds, matchCount);
  const historicalDpm = totalSurvivalMinutes > 0 ? totalDamage / totalSurvivalMinutes : 0;
  const historicalDamagePerKill = totalKills > 0 ? totalDamage / totalKills : null;
  const historicalKnockConversionRate = totalKnocks > 0 ? totalKills / totalKnocks : null;
  const damageStability = calculateDamageStability(matches);
  const distributionTotal = totalKills + totalAssists + totalPureKnocks;

  return {
    matchCount,
    totalDamage,
    totalKills,
    totalAssists,
    totalKnocks,
    totalPureKnocks,
    totalSurvivalSeconds,
    avgDamage,
    avgKills,
    avgAssists,
    avgKnocks,
    avgSurvivalSeconds,
    historicalDpm,
    historicalDamagePerKill,
    historicalKnockConversionRate,
    damageStability,
    finishDistribution: {
      kills: divide(totalKills, distributionTotal),
      assists: divide(totalAssists, distributionTotal),
      pureKnocks: divide(totalPureKnocks, distributionTotal),
    },
    radar: {
      avgDamage: normalize(avgDamage, RADAR_LIMITS.avgDamage),
      avgKills: normalize(avgKills, RADAR_LIMITS.avgKills),
      avgSurvivalTime: normalize(avgSurvivalSeconds / 60, RADAR_LIMITS.avgSurvivalMinutes),
      avgKnocks: normalize(avgKnocks, RADAR_LIMITS.avgKnocks),
      finishConversion: historicalKnockConversionRate === null ? 0 : clamp(historicalKnockConversionRate * 100, 0, 100),
      outputStability: damageStability ?? 0,
    },
  };
}

export function calculateDamageStability(matches: MatchRecord[]) {
  if (matches.length < 3) {
    return null;
  }

  const averageDamage = sum(matches, (match) => match.damage) / matches.length;
  if (averageDamage <= 0) {
    return 0;
  }

  const variance =
    sum(matches, (match) => {
      const delta = match.damage - averageDamage;
      return delta * delta;
    }) / matches.length;

  const standardDeviation = Math.sqrt(variance);
  return clamp(100 - (standardDeviation / averageDamage) * 50, 0, 100);
}

function normalize(value: number, limit: number) {
  if (limit <= 0) {
    return 0;
  }
  return clamp((value / limit) * 100, 0, 100);
}

function createZoneScoreComponents(playerMetrics: HistoryMetrics, siteMetrics: HistoryMetrics): ZoneScoreComponent[] {
  return [
    createZoneScoreComponent("场均伤害", playerMetrics.avgDamage, siteMetrics.avgDamage, ZONE_SCORE_BASELINES.avgDamage, 30),
    createZoneScoreComponent("历史 DPM", playerMetrics.historicalDpm, siteMetrics.historicalDpm, ZONE_SCORE_BASELINES.historicalDpm, 15),
    createZoneScoreComponent("场均击杀", playerMetrics.avgKills, siteMetrics.avgKills, ZONE_SCORE_BASELINES.avgKills, 14),
    createZoneScoreComponent("场均击倒", playerMetrics.avgKnocks, siteMetrics.avgKnocks, ZONE_SCORE_BASELINES.avgKnocks, 12),
    createZoneScoreComponent(
      "输出稳定",
      playerMetrics.damageStability,
      siteMetrics.damageStability,
      ZONE_SCORE_BASELINES.damageStability,
      10,
    ),
    createZoneScoreComponent(
      "终结转化",
      playerMetrics.historicalKnockConversionRate,
      siteMetrics.historicalKnockConversionRate,
      ZONE_SCORE_BASELINES.knockConversionRate,
      8,
    ),
    createZoneScoreComponent("场均助攻", playerMetrics.avgAssists, siteMetrics.avgAssists, ZONE_SCORE_BASELINES.avgAssists, 6),
    createZoneScoreComponent(
      "场均存活",
      playerMetrics.avgSurvivalSeconds,
      siteMetrics.avgSurvivalSeconds,
      ZONE_SCORE_BASELINES.avgSurvivalSeconds,
      5,
    ),
  ];
}

function calculateZoneScoreValue(components: ZoneScoreComponent[]) {
  const weightedScore = components.reduce((total, component) => total + component.score * component.weight, 0) / 100;
  return Math.round(clamp(weightedScore, 0, 100));
}

function createZoneScoreComponent(
  label: string,
  playerValue: number | null,
  siteValue: number | null,
  fallbackSiteValue: number,
  weight: number,
): ZoneScoreComponent {
  return {
    label,
    score: compareToSiteAverage(playerValue, siteValue, fallbackSiteValue),
    weight,
    playerValue,
    siteValue,
  };
}

function compareToSiteAverage(playerValue: number | null, siteValue: number | null, fallbackSiteValue: number) {
  if (playerValue === null || !Number.isFinite(playerValue)) {
    return 50;
  }

  const comparisonBase = siteValue !== null && Number.isFinite(siteValue) && siteValue > 0 ? siteValue : fallbackSiteValue;
  if (!Number.isFinite(comparisonBase) || comparisonBase <= 0) {
    return 50;
  }

  const ratio = Math.max(playerValue, 0) / comparisonBase;
  return Math.round(clamp(50 + Math.log(ratio) * 46, 0, 100));
}

function getZoneScoreTitle(score: number) {
  if (score >= 88) {
    return ZONE_SCORE_TITLES[0];
  }

  if (score >= 72) {
    return ZONE_SCORE_TITLES[1];
  }

  if (score >= 50) {
    return ZONE_SCORE_TITLES[2];
  }

  if (score >= 30) {
    return ZONE_SCORE_TITLES[3];
  }

  return ZONE_SCORE_TITLES[4];
}

function createZoneScoreExplanation(score: number, strongest: ZoneScoreComponent, weakest: ZoneScoreComponent) {
  const trend =
    score >= 88
      ? "火力过于夸张，已经进入伤害团队级别"
      : score >= 72
        ? "整体明显高于网站平均，是队伍里的稳定大腿"
        : score >= 50
          ? "整体接近网站平均，属于正常人类水平"
          : score >= 30
            ? "整体略低于网站平均，偶尔会有犯病表现"
            : "多项数据明显低于网站平均，需要下一局把风评打回来";

  return `${trend}；${strongest.label}最能拉分，${weakest.label}目前拖后腿。评分根据玩家历史均值与网站平均的相对表现加权得到。`;
}

function sum<T>(items: T[], selector: (item: T) => number) {
  return items.reduce((total, item) => total + selector(item), 0);
}

function divide(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : 0;
}
