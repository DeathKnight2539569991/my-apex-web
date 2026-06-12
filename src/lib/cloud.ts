import type { CloudDataResponse, CommentDataResponse, MatchRecord, PlayerComment } from "../types";

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

export async function fetchPlayerComments(playerId: string): Promise<CommentDataResponse> {
  return requestComments(`/api/comments?playerId=${encodeURIComponent(playerId)}`);
}

export async function savePlayerComment(playerId: string, nickname: string, content: string): Promise<CommentDataResponse> {
  return requestComments("/api/comments", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ playerId, nickname, content }),
  });
}

export async function likePlayerComment(playerId: string, commentId: string): Promise<CommentDataResponse> {
  return requestComments("/api/comments", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ playerId, commentId }),
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

async function requestComments(path: string, init?: RequestInit): Promise<CommentDataResponse> {
  const response = await fetch(path, init);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error ?? "评论请求失败。");
  }

  if (!isCommentDataResponse(payload)) {
    throw new Error("评论响应格式异常，请确认 /api/comments 已可用。");
  }

  return payload;
}

function isCloudDataResponse(value: unknown): value is CloudDataResponse {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    Array.isArray((value as CloudDataResponse).matches) &&
    Array.isArray((value as CloudDataResponse).players) &&
    Array.isArray((value as CloudDataResponse).playerMetrics) &&
    Boolean((value as CloudDataResponse).siteMetrics) &&
    typeof (value as CloudDataResponse).siteMetrics === "object"
  );
}

function isCommentDataResponse(value: unknown): value is CommentDataResponse {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    Array.isArray((value as CommentDataResponse).comments) &&
    (value as CommentDataResponse).comments.every(isPlayerComment)
  );
}

function isPlayerComment(value: unknown): value is PlayerComment {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as PlayerComment).id === "string" &&
    typeof (value as PlayerComment).playerId === "string" &&
    typeof (value as PlayerComment).nickname === "string" &&
    typeof (value as PlayerComment).content === "string" &&
    typeof (value as PlayerComment).createdAt === "string" &&
    typeof (value as PlayerComment).likes === "number"
  );
}
