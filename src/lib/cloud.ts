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

export async function deleteCloudPlayer(playerId: string): Promise<CloudDataResponse> {
  return requestCloud(`/api/matches?playerId=${encodeURIComponent(playerId)}`, {
    method: "DELETE",
  });
}

async function requestCloud(path: string, init?: RequestInit) {
  const response = await fetch(path, init);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error ?? "云端请求失败。");
  }

  return payload;
}
