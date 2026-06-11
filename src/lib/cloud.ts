import type { CloudDataResponse, MatchRecord } from "../types";

export async function fetchCloudData(playerId?: string): Promise<CloudDataResponse> {
  const query = playerId ? `?playerId=${encodeURIComponent(playerId)}` : "";
  return requestCloud(`/api/matches${query}`);
}

export async function saveCloudMatch(match: MatchRecord): Promise<CloudDataResponse> {
  return requestCloud("/api/matches", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ match }),
  });
}

export async function deleteCloudPlayer(playerId: string, adminToken: string): Promise<CloudDataResponse> {
  return requestCloud(`/api/matches?playerId=${encodeURIComponent(playerId)}`, {
    method: "DELETE",
    headers: {
      "X-Admin-Delete-Token": adminToken,
    },
  });
}

export async function deleteCloudMatch(playerId: string, matchId: string): Promise<CloudDataResponse> {
  return requestCloud(`/api/matches?playerId=${encodeURIComponent(playerId)}&matchId=${encodeURIComponent(matchId)}`, {
    method: "DELETE",
  });
}

async function requestCloud(path: string, init?: RequestInit): Promise<CloudDataResponse> {
  const response = await fetch(path, init);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error ?? "云端请求失败。");
  }

  if (!isCloudDataResponse(payload)) {
    throw new Error("云端响应格式异常，请确认 /api/matches 已可用。");
  }

  return {
    ...payload,
    adminDeleteEnabled: Boolean(payload.adminDeleteEnabled),
  };
}

function isCloudDataResponse(value: unknown): value is CloudDataResponse {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    Array.isArray((value as CloudDataResponse).matches) &&
    Array.isArray((value as CloudDataResponse).players) &&
    Boolean((value as CloudDataResponse).siteMetrics) &&
    typeof (value as CloudDataResponse).siteMetrics === "object"
  );
}
