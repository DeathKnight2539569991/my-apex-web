import type { HistoryMetrics, MatchRecord, SingleMatchMetrics } from "../types";
import { clamp } from "./format";

const RADAR_LIMITS = {
  avgDamage: 1500,
  avgKills: 5,
  avgSurvivalMinutes: 20,
  avgKnocks: 7,
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

function sum<T>(items: T[], selector: (item: T) => number) {
  return items.reduce((total, item) => total + selector(item), 0);
}

function divide(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : 0;
}
