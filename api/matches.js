const PLAYERS_KEY = "apex:players:v1";
const PLAYER_PREFIX = "apex:matches:v1:";
const COMMENT_PREFIX = "apex:comments:v1:";

export default async function handler(request, response) {
  try {
    if (!isCloudConfigured()) {
      return sendJson(response, 500, {
        error: "Cloud storage is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN in Vercel.",
      });
    }

    if (request.method === "GET") {
      const playerId = getPlayerId(request);
      return sendJson(response, 200, await getCloudPayload(playerId));
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request);
      const match = sanitizeMatch(body?.match);

      if (!match) {
        return sendJson(response, 400, { error: "Invalid match payload." });
      }

      const existingMatches = await getPlayerMatches(match.playerId);
      const nextMatches = [...existingMatches.filter((item) => item.id !== match.id), match].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      );

      await redis(["SET", getPlayerKey(match.playerId), JSON.stringify(nextMatches)]);
      await redis(["SADD", PLAYERS_KEY, match.playerId]);

      return sendJson(response, 200, await getCloudPayload(match.playerId));
    }

    if (request.method === "DELETE") {
      const playerId = getPlayerId(request);
      if (!playerId) {
        return sendJson(response, 400, { error: "playerId is required." });
      }

      const matchId = getMatchId(request);
      if (matchId) {
        return sendJson(response, 200, await deletePlayerMatch(playerId, matchId));
      }

      if (!isAdminDeleteEnabled()) {
        return sendJson(response, 403, { error: "Whole-player deletion is disabled because ADMIN_DELETE_TOKEN is not configured." });
      }

      if (!isValidAdminDeleteToken(request)) {
        return sendJson(response, 403, { error: "Invalid administrator delete token." });
      }

      await redis(["DEL", getPlayerKey(playerId)]);
      await redis(["DEL", getCommentKey(playerId)]);
      await redis(["SREM", PLAYERS_KEY, playerId]);

      return sendJson(response, 200, await getCloudPayload(""));
    }

    response.setHeader("Allow", "GET, POST, DELETE");
    return sendJson(response, 405, { error: "Method not allowed." });
  } catch (error) {
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    return sendJson(response, statusCode, {
      error: error instanceof Error ? error.message : "Unexpected cloud API error.",
    });
  }
}

async function getCloudPayload(playerId) {
  const players = await getPlayers();
  const matches = playerId ? await getPlayerMatches(playerId) : [];
  const playerMatchGroups = await getPlayerMatchGroups(players);
  const allMatches = playerMatchGroups.flatMap((group) => group.matches);

  return {
    matches,
    players,
    siteMetrics: calculateHistoryMetrics(allMatches),
    playerMetrics: playerMatchGroups.map((group) => ({
      playerId: group.playerId,
      metrics: calculateHistoryMetrics(group.matches),
    })),
    adminDeleteEnabled: isAdminDeleteEnabled(),
  };
}

async function deletePlayerMatch(playerId, matchId) {
  const existingMatches = await getPlayerMatches(playerId);
  const nextMatches = existingMatches.filter((match) => match.id !== matchId);

  if (nextMatches.length === existingMatches.length) {
    const error = new Error("Match record not found.");
    error.statusCode = 404;
    throw error;
  }

  if (nextMatches.length > 0) {
    await redis(["SET", getPlayerKey(playerId), JSON.stringify(nextMatches)]);
    await redis(["SADD", PLAYERS_KEY, playerId]);
  } else {
    await redis(["DEL", getPlayerKey(playerId)]);
    await redis(["SREM", PLAYERS_KEY, playerId]);
  }

  return getCloudPayload(playerId);
}

async function getPlayers() {
  const result = await redis(["SMEMBERS", PLAYERS_KEY]);
  return Array.isArray(result) ? result.sort((a, b) => a.localeCompare(b)) : [];
}

async function getPlayerMatches(playerId) {
  if (!playerId) {
    return [];
  }

  const result = await redis(["GET", getPlayerKey(playerId)]);
  if (!result) {
    return [];
  }

  try {
    const parsed = JSON.parse(result);
    return Array.isArray(parsed) ? parsed.filter(isMatchRecord) : [];
  } catch {
    return [];
  }
}

async function getPlayerMatchGroups(players) {
  if (players.length === 0) {
    return [];
  }

  const result = await redis(["MGET", ...players.map(getPlayerKey)]);
  const values = Array.isArray(result) ? result : [];

  return players.map((playerId, index) => ({
    playerId,
    matches: parseMatchList(values[index]),
  }));
}

function parseMatchList(value) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(isMatchRecord) : [];
  } catch {
    return [];
  }
}

async function redis(command) {
  const redisUrl = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

  const redisResponse = await fetch(redisUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${redisToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  const payload = await redisResponse.json();
  if (!redisResponse.ok || payload.error) {
    throw new Error(payload.error ?? "Redis REST request failed.");
  }

  return payload.result;
}

function calculateHistoryMetrics(matches) {
  const matchCount = matches.length;
  const totalDamage = sum(matches, (match) => match.damage);
  const totalKills = sum(matches, (match) => match.kills);
  const totalAssists = sum(matches, (match) => match.assists);
  const totalKnocks = sum(matches, (match) => match.knocks);
  const totalPureKnocks = sum(matches, (match) => Math.max(match.knocks - match.kills, 0));
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
      avgDamage,
      avgKills,
      avgSurvivalTime: avgSurvivalSeconds / 60,
      avgKnocks,
      finishConversion: historicalKnockConversionRate === null ? 0 : clamp(historicalKnockConversionRate * 100, 0, 100),
      outputStability: damageStability ?? 0,
    },
  };
}

function calculateDamageStability(matches) {
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

  return clamp(100 - (Math.sqrt(variance) / averageDamage) * 50, 0, 100);
}

function isCloudConfigured() {
  return Boolean(
    (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) ||
      (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN),
  );
}

function isAdminDeleteEnabled() {
  return Boolean(process.env.ADMIN_DELETE_TOKEN);
}

function isValidAdminDeleteToken(request) {
  const expectedToken = process.env.ADMIN_DELETE_TOKEN;
  const providedToken = getHeader(request, "x-admin-delete-token");
  return Boolean(expectedToken) && providedToken === expectedToken;
}

function getPlayerId(request) {
  return getSearchParam(request, "playerId");
}

function getMatchId(request) {
  return getSearchParam(request, "matchId");
}

function getSearchParam(request, key) {
  const url = new URL(request.url, `https://${request.headers.host ?? "localhost"}`);
  return url.searchParams.get(key)?.trim() ?? "";
}

function getHeader(request, name) {
  if (typeof request.headers?.get === "function") {
    return request.headers.get(name) ?? "";
  }

  const value = request.headers?.[name.toLowerCase()] ?? request.headers?.[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

async function readJsonBody(request) {
  if (request.body && typeof request.body === "object" && !isReadableStream(request.body)) {
    return request.body;
  }

  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sanitizeMatch(value) {
  if (!isMatchRecord(value)) {
    return null;
  }

  return {
    id: value.id,
    playerId: value.playerId.trim(),
    kills: Math.max(0, Math.trunc(value.kills)),
    assists: Math.max(0, Math.trunc(value.assists)),
    knocks: Math.max(0, Math.trunc(value.knocks)),
    damage: Math.max(0, Math.trunc(value.damage)),
    survivalSeconds: Math.max(1, Math.trunc(value.survivalSeconds)),
    createdAt: value.createdAt,
    sourceImageName: typeof value.sourceImageName === "string" ? value.sourceImageName : undefined,
  };
}

function isMatchRecord(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.id === "string" &&
    typeof value.playerId === "string" &&
    value.playerId.trim().length > 0 &&
    typeof value.kills === "number" &&
    typeof value.assists === "number" &&
    typeof value.knocks === "number" &&
    typeof value.damage === "number" &&
    typeof value.survivalSeconds === "number" &&
    typeof value.createdAt === "string"
  );
}

function getPlayerKey(playerId) {
  return `${PLAYER_PREFIX}${Buffer.from(playerId, "utf8").toString("base64url")}`;
}

function getCommentKey(playerId) {
  return `${COMMENT_PREFIX}${Buffer.from(playerId, "utf8").toString("base64url")}`;
}

function isReadableStream(value) {
  return typeof value?.getReader === "function";
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function sum(items, selector) {
  return items.reduce((total, item) => total + selector(item), 0);
}

function divide(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
