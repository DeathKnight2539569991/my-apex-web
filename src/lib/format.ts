export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function parseNumber(value: string) {
  const cleaned = value.replace(/,/g, "").trim();
  if (!cleaned) {
    return Number.NaN;
  }
  return Number(cleaned);
}

export function parseDurationToSeconds(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return Number.NaN;
  }

  const parts = trimmed.split(":").map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part) || part < 0)) {
    return Number.NaN;
  }

  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    if (seconds >= 60) {
      return Number.NaN;
    }
    return minutes * 60 + seconds;
  }

  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    if (minutes >= 60 || seconds >= 60) {
      return Number.NaN;
    }
    return hours * 3600 + minutes * 60 + seconds;
  }

  const asSeconds = Number(trimmed);
  return Number.isNaN(asSeconds) ? Number.NaN : asSeconds;
}

export function formatDuration(seconds: number) {
  const safeSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

export function formatNumber(value: number, digits = 0) {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

export function formatPercent(value: number | null, digits = 0) {
  if (value === null) {
    return "无击倒";
  }
  return `${formatNumber(value * 100, digits)}%`;
}
