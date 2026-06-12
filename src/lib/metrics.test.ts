import { describe, expect, it } from "vitest";
import type { HistoryMetrics, MatchRecord, PlayerMetricsEntry } from "../types";
import { formatDuration, parseDurationToSeconds, parseNumber } from "./format";
import { calculateHistoryMetrics, calculateSingleMatchMetrics, calculateZoneScore } from "./metrics";
import { extractMatchDraftFromText } from "./ocr";

const baseMatch: MatchRecord = {
  id: "1",
  playerId: "[POM] SangJoon",
  kills: 14,
  assists: 0,
  knocks: 21,
  damage: 5522,
  survivalSeconds: 1213,
  createdAt: "2026-06-11T00:00:00.000Z",
};

describe("format helpers", () => {
  it("parses comma numbers", () => {
    expect(parseNumber("5,522")).toBe(5522);
  });

  it("parses and formats match survival time", () => {
    expect(parseDurationToSeconds("20:13")).toBe(1213);
    expect(formatDuration(1213)).toBe("20:13");
  });
});

describe("OCR draft extraction", () => {
  it("extracts the simplified Apex stat card fields", () => {
    const text = `
      [POM] SangJoon
      击杀 / 助攻 / 击倒
      14 / 0 / 21
      造成伤害
      5,522
      生存时间
      20:13
    `;

    expect(extractMatchDraftFromText(text)).toMatchObject({
      playerId: "",
      kills: "14",
      assists: "0",
      knocks: "21",
      damage: "5,522",
      survivalTime: "20:13",
    });
  });

  it("extracts the common Apex left stat panel fields", () => {
    const text = `
      DK
      击杀 / 助攻 / 击倒
      1/3/1
      造成伤害
      143
      生存时间
      3:43
      急救次数
      0
      重生次数
      0
    `;

    expect(extractMatchDraftFromText(text)).toMatchObject({
      playerId: "",
      kills: "1",
      assists: "3",
      knocks: "1",
      damage: "143",
      survivalTime: "3:43",
    });
  });
});

describe("single match metrics", () => {
  it("calculates DPM, damage per kill, conversion, and pure knocks", () => {
    const metrics = calculateSingleMatchMetrics(baseMatch);

    expect(metrics.dpm).toBeCloseTo(273.14, 2);
    expect(metrics.damagePerKill).toBeCloseTo(394.43, 2);
    expect(metrics.knockConversionRate).toBeCloseTo(0.6667, 4);
    expect(metrics.pureKnocks).toBe(7);
  });

  it("marks zero-kill damage per kill as invalid damage", () => {
    const metrics = calculateSingleMatchMetrics({ ...baseMatch, kills: 0 });

    expect(metrics.damagePerKill).toBeNull();
  });
});

describe("history metrics", () => {
  it("aggregates all historical matches", () => {
    const metrics = calculateHistoryMetrics([
      baseMatch,
      { ...baseMatch, id: "2", kills: 0, assists: 4, knocks: 3, damage: 600, survivalSeconds: 600 },
      { ...baseMatch, id: "3", kills: 2, assists: 1, knocks: 4, damage: 900, survivalSeconds: 900 },
    ]);

    expect(metrics.matchCount).toBe(3);
    expect(metrics.avgDamage).toBeCloseTo(2340.67, 2);
    expect(metrics.historicalDamagePerKill).toBeCloseTo(438.88, 2);
    expect(metrics.historicalKnockConversionRate).toBeCloseTo(16 / 28, 4);
    expect(metrics.damageStability).not.toBeNull();
    expect(metrics.radar.avgDamage).toBe(100);
  });
});

describe("zone score", () => {
  it("returns an empty state when the player has no matches", () => {
    const score = calculateZoneScore(calculateHistoryMetrics([]), calculateHistoryMetrics([]));

    expect(score.score).toBe(0);
    expect(score.title).toBe("暂无评分");
    expect(score.components).toHaveLength(0);
  });

  it("keeps an average player in the normal human tier", () => {
    const siteMetrics = createSyntheticHistoryMetrics(1);
    const score = calculateZoneScore(createSyntheticHistoryMetrics(1), siteMetrics);

    expect(score.score).toBe(50);
    expect(score.title).toBe("正常人类😀");
    expect(score.components).toHaveLength(8);
    expect(score.components.map((component) => [component.label, component.weight])).toEqual([
      ["场均伤害", 30],
      ["历史 DPM", 15],
      ["场均击杀", 14],
      ["场均击倒", 12],
      ["输出稳定", 10],
      ["终结转化", 8],
      ["场均助攻", 6],
      ["场均存活", 5],
    ]);
    expect(score.explanation).toContain("正常人类水平");
  });

  it("puts clearly above-average players into the carry tier", () => {
    const score = calculateZoneScore(createSyntheticHistoryMetrics(1.65), createSyntheticHistoryMetrics(1));

    expect(score.score).toBeGreaterThanOrEqual(72);
    expect(score.score).toBeLessThan(88);
    expect(score.title).toBe("团队大腿🥵");
  });

  it("puts elite players into the damage-team tier", () => {
    const score = calculateZoneScore(createSyntheticHistoryMetrics(2.3), createSyntheticHistoryMetrics(1));

    expect(score.score).toBeGreaterThanOrEqual(88);
    expect(score.title).toBe("伤害团队😭");
  });

  it("puts below-average players into the occasional-throw tier", () => {
    const score = calculateZoneScore(createSyntheticHistoryMetrics(0.7), createSyntheticHistoryMetrics(1));

    expect(score.score).toBeLessThan(50);
    expect(score.score).toBeGreaterThanOrEqual(30);
    expect(score.title).toBe("偶尔犯病😒");
  });

  it("puts very low players into the bottom tier", () => {
    const score = calculateZoneScore(createSyntheticHistoryMetrics(0.5), createSyntheticHistoryMetrics(1));

    expect(score.score).toBeLessThan(30);
    expect(score.title).toBe("究极大区🤣");
  });

  it("does not let leaderboard context change the score title", () => {
    const siteMetrics = createSyntheticHistoryMetrics(1);
    const targetMetrics = createSyntheticHistoryMetrics(0.7);
    const playerMetrics: PlayerMetricsEntry[] = [
      { playerId: "target-player", metrics: targetMetrics },
      { playerId: "elite-player", metrics: createSyntheticHistoryMetrics(2.3) },
      { playerId: "average-player", metrics: createSyntheticHistoryMetrics(1) },
      { playerId: "low-player", metrics: createSyntheticHistoryMetrics(0.5) },
    ];

    const absoluteScore = calculateZoneScore(targetMetrics, siteMetrics);
    const rankedScore = calculateZoneScore(targetMetrics, siteMetrics, {
      playerId: "target-player",
      playerMetrics,
    });

    expect(rankedScore.score).toBe(absoluteScore.score);
    expect(rankedScore.title).toBe(absoluteScore.title);
    expect(rankedScore.title).toBe("偶尔犯病😒");
  });

  it("keeps missing nullable metrics neutral while zero values still score low", () => {
    const siteMetrics = createSyntheticHistoryMetrics(1);
    const playerMetrics: HistoryMetrics = {
      ...createSyntheticHistoryMetrics(1),
      avgDamage: 0,
      historicalKnockConversionRate: null,
      damageStability: null,
    };

    const score = calculateZoneScore(playerMetrics, siteMetrics);
    const damage = score.components.find((component) => component.label === "场均伤害");
    const conversion = score.components.find((component) => component.label === "终结转化");
    const stability = score.components.find((component) => component.label === "输出稳定");

    expect(damage?.score).toBe(0);
    expect(conversion?.score).toBe(50);
    expect(stability?.score).toBe(50);
  });
});

function createSyntheticHistoryMetrics(ratio: number): HistoryMetrics {
  const matchCount = 10;
  const avgDamage = 600 * ratio;
  const avgKills = 1.2 * ratio;
  const avgAssists = 1 * ratio;
  const avgKnocks = 2.4 * ratio;
  const avgSurvivalSeconds = 600 * ratio;
  const totalDamage = avgDamage * matchCount;
  const totalKills = avgKills * matchCount;
  const totalAssists = avgAssists * matchCount;
  const totalKnocks = avgKnocks * matchCount;
  const totalPureKnocks = Math.max(totalKnocks - totalKills, 0);
  const totalSurvivalSeconds = avgSurvivalSeconds * matchCount;
  const historicalKnockConversionRate = 0.4 * ratio;
  const damageStability = 40 * ratio;
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
    historicalDpm: 90 * ratio,
    historicalDamagePerKill: totalKills > 0 ? totalDamage / totalKills : null,
    historicalKnockConversionRate,
    damageStability,
    finishDistribution: {
      kills: totalKills / distributionTotal,
      assists: totalAssists / distributionTotal,
      pureKnocks: totalPureKnocks / distributionTotal,
    },
    radar: {
      avgDamage: 0,
      avgKills: 0,
      avgSurvivalTime: 0,
      avgKnocks: 0,
      finishConversion: historicalKnockConversionRate * 100,
      outputStability: damageStability,
    },
  };
}
