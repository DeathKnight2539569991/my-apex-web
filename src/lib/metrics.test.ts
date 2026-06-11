import { describe, expect, it } from "vitest";
import type { MatchRecord, PlayerMetricsEntry } from "../types";
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

  it("scores player history against site averages", () => {
    const siteMetrics = calculateHistoryMetrics([
      { ...baseMatch, id: "site-1", kills: 1, assists: 1, knocks: 2, damage: 500, survivalSeconds: 600 },
      { ...baseMatch, id: "site-2", kills: 1, assists: 0, knocks: 1, damage: 450, survivalSeconds: 540 },
      { ...baseMatch, id: "site-3", kills: 2, assists: 1, knocks: 3, damage: 800, survivalSeconds: 780 },
    ]);
    const playerMetrics = calculateHistoryMetrics([
      { ...baseMatch, id: "player-1", kills: 5, assists: 3, knocks: 7, damage: 1800, survivalSeconds: 1000 },
      { ...baseMatch, id: "player-2", kills: 4, assists: 2, knocks: 6, damage: 1600, survivalSeconds: 900 },
      { ...baseMatch, id: "player-3", kills: 3, assists: 4, knocks: 5, damage: 1500, survivalSeconds: 880 },
    ]);

    const score = calculateZoneScore(playerMetrics, siteMetrics);

    expect(score.score).toBeGreaterThan(70);
    expect(score.components).toHaveLength(8);
    expect(score.explanation).toContain("网站平均");
  });

  it("keeps the numeric score stable when ranked title context is provided", () => {
    const { playerMetrics, siteMetrics } = createRankingScenario(5);
    const entry = playerMetrics[2];

    const absoluteScore = calculateZoneScore(entry.metrics, siteMetrics);
    const rankedScore = calculateZoneScore(entry.metrics, siteMetrics, {
      playerId: entry.playerId,
      playerMetrics,
    });

    expect(rankedScore.score).toBe(absoluteScore.score);
  });

  it("uses only the top ranked titles for two to four cloud players", () => {
    const { playerMetrics, siteMetrics } = createRankingScenario(4);

    const titles = playerMetrics.map((entry) =>
      calculateZoneScore(entry.metrics, siteMetrics, {
        playerId: entry.playerId,
        playerMetrics,
      }).title,
    );

    expect(titles).toEqual(["究极大区 🤣", "团队大腿🥵", "正常人类😀", "偶尔犯病😒"]);
    expect(titles).not.toContain("伤害团队😭");
  });

  it("assigns one title per rank when there are five cloud players", () => {
    const { playerMetrics, siteMetrics } = createRankingScenario(5);

    const titles = playerMetrics.map((entry) =>
      calculateZoneScore(entry.metrics, siteMetrics, {
        playerId: entry.playerId,
        playerMetrics,
      }).title,
    );

    expect(titles).toEqual(["究极大区 🤣", "团队大腿🥵", "正常人类😀", "偶尔犯病😒", "伤害团队😭"]);
  });

  it("splits ranked titles proportionally when there are more than five cloud players", () => {
    const { playerMetrics, siteMetrics } = createRankingScenario(10);
    const titles = playerMetrics.map((entry) =>
      calculateZoneScore(entry.metrics, siteMetrics, {
        playerId: entry.playerId,
        playerMetrics,
      }).title,
    );

    expect(countByTitle(titles)).toEqual({
      "究极大区 🤣": 2,
      "团队大腿🥵": 2,
      "正常人类😀": 2,
      "偶尔犯病😒": 2,
      "伤害团队😭": 2,
    });
  });

  it("falls back to absolute score titles when the current player is not ranked", () => {
    const { playerMetrics, siteMetrics } = createRankingScenario(5);
    const entry = playerMetrics[0];

    const absoluteScore = calculateZoneScore(entry.metrics, siteMetrics);
    const missingRankScore = calculateZoneScore(entry.metrics, siteMetrics, {
      playerId: "missing-player",
      playerMetrics,
    });

    expect(missingRankScore.title).toBe(absoluteScore.title);
  });
});

function createRankingScenario(playerCount: number) {
  const matches = Array.from({ length: playerCount }, (_, index) => createRankedMatch(index));
  const siteMetrics = calculateHistoryMetrics(matches);
  const playerMetrics: PlayerMetricsEntry[] = matches.map((match) => ({
    playerId: match.playerId,
    metrics: calculateHistoryMetrics([match]),
  }));

  return { matches, playerMetrics, siteMetrics };
}

function createRankedMatch(index: number): MatchRecord {
  const strength = 20 - index;

  return {
    ...baseMatch,
    id: `ranked-${index + 1}`,
    playerId: `player-${String(index + 1).padStart(2, "0")}`,
    kills: strength,
    assists: Math.floor(strength / 2),
    knocks: strength + 3,
    damage: strength * 120,
    survivalSeconds: 720,
  };
}

function countByTitle(titles: string[]) {
  return titles.reduce<Record<string, number>>((counts, title) => {
    counts[title] = (counts[title] ?? 0) + 1;
    return counts;
  }, {});
}
