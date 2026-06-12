const COMMENT_PREFIX = "apex:comments:v1:";
const COMMENT_LIMIT = 100;

export default async function handler(request, response) {
  try {
    if (!isCloudConfigured()) {
      return sendJson(response, 500, {
        error: "Cloud storage is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN in Vercel.",
      });
    }

    if (request.method === "GET") {
      const playerId = sanitizePlayerId(getPlayerId(request));
      if (!playerId) {
        return sendJson(response, 400, { error: "playerId is required." });
      }

      return sendJson(response, 200, await getCommentsPayload(playerId));
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request);
      const comment = sanitizeNewComment(body);

      if (!comment) {
        return sendJson(response, 400, { error: "Invalid comment payload." });
      }

      const existingComments = await getStoredPlayerComments(comment.playerId);
      const nextComments = [...existingComments, comment]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-COMMENT_LIMIT);

      await redis(["SET", getCommentKey(comment.playerId), JSON.stringify(nextComments)]);

      return sendJson(response, 200, toCommentsPayload(nextComments));
    }

    if (request.method === "PATCH") {
      const body = await readJsonBody(request);
      const playerId = sanitizePlayerId(body?.playerId);
      const commentId = typeof body?.commentId === "string" ? body.commentId.trim() : "";

      if (!playerId || !commentId) {
        return sendJson(response, 400, { error: "playerId and commentId are required." });
      }

      return sendJson(response, 200, await likeComment(playerId, commentId));
    }

    response.setHeader("Allow", "GET, POST, PATCH");
    return sendJson(response, 405, { error: "Method not allowed." });
  } catch (error) {
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    return sendJson(response, statusCode, {
      error: error instanceof Error ? error.message : "Unexpected comments API error.",
    });
  }
}

async function getCommentsPayload(playerId) {
  const comments = await getStoredPlayerComments(playerId);
  return toCommentsPayload(comments);
}

function toCommentsPayload(comments) {
  return {
    comments: comments.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}

async function likeComment(playerId, commentId) {
  const existingComments = await getStoredPlayerComments(playerId);
  let found = false;
  const nextComments = existingComments.map((comment) => {
    if (comment.id !== commentId) {
      return comment;
    }

    found = true;
    return {
      ...comment,
      likes: Math.max(0, Math.trunc(comment.likes)) + 1,
    };
  });

  if (!found) {
    const error = new Error("Comment not found.");
    error.statusCode = 404;
    throw error;
  }

  await redis(["SET", getCommentKey(playerId), JSON.stringify(nextComments)]);
  return toCommentsPayload(nextComments);
}

async function getStoredPlayerComments(playerId) {
  const result = await redis(["GET", getCommentKey(playerId)]);
  if (!result) {
    return [];
  }

  try {
    const parsed = JSON.parse(result);
    return Array.isArray(parsed)
      ? parsed
          .filter(isCommentRecord)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .slice(-COMMENT_LIMIT)
      : [];
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

function sanitizeNewComment(value) {
  const playerId = sanitizePlayerId(value?.playerId);
  const nickname = sanitizeLimitedText(value?.nickname, 1, 12);
  const content = sanitizeLimitedText(value?.content, 1, 200);

  if (!playerId || !nickname || !content) {
    return null;
  }

  return {
    id: createId(),
    playerId,
    nickname,
    content,
    createdAt: new Date().toISOString(),
    likes: 0,
  };
}

function sanitizePlayerId(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function sanitizeLimitedText(value, minLength, maxLength) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  const length = Array.from(trimmed).length;
  if (length < minLength || length > maxLength) {
    return "";
  }

  return trimmed;
}

function isCommentRecord(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.id === "string" &&
    typeof value.playerId === "string" &&
    value.playerId.trim().length > 0 &&
    typeof value.nickname === "string" &&
    countTextLength(value.nickname.trim()) >= 1 &&
    countTextLength(value.nickname.trim()) <= 12 &&
    typeof value.content === "string" &&
    countTextLength(value.content.trim()) >= 1 &&
    countTextLength(value.content.trim()) <= 200 &&
    typeof value.createdAt === "string" &&
    typeof value.likes === "number" &&
    Number.isFinite(value.likes) &&
    value.likes >= 0
  );
}

function countTextLength(value) {
  return Array.from(value).length;
}

function getPlayerId(request) {
  return getSearchParam(request, "playerId");
}

function getSearchParam(request, key) {
  const url = new URL(request.url, `https://${request.headers.host ?? "localhost"}`);
  return url.searchParams.get(key)?.trim() ?? "";
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

function isCloudConfigured() {
  return Boolean(
    (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) ||
      (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN),
  );
}

function getCommentKey(playerId) {
  return `${COMMENT_PREFIX}${Buffer.from(playerId, "utf8").toString("base64url")}`;
}

function createId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isReadableStream(value) {
  return typeof value?.getReader === "function";
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}
