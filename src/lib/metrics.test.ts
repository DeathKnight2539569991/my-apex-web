import { describe, expect, it } from "vitest";
import type { MatchRecord } from "../types";
import { formatDuration, parseDurationToSeconds, parseNumber } from "./format";
import { calculateHistoryMetrics, calculateSingleMatchMetrics } from "./metrics";
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
      playerId: "[POM] SangJoon",
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
      playerId: "DK",
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
