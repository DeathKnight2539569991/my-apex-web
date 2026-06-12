import Tesseract from "tesseract.js";
import type { MatchDraft } from "../types";

type OcrProgress = {
  status: string;
  progress: number;
};

export type RecognizeImageOptions = {
  cropMode?: "stats-panel" | "none";
};

export type OcrResult = {
  text: string;
  processedImageUrl: string;
  crop: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  source: {
    width: number;
    height: number;
  };
};

const emptyDraft: MatchDraft = {
  playerId: "",
  kills: "",
  assists: "",
  knocks: "",
  damage: "",
  survivalTime: "",
};

export async function recognizeImage(
  file: File,
  onProgress?: (progress: OcrProgress) => void,
  options: RecognizeImageOptions = {},
): Promise<OcrResult> {
  const processed = await preprocessStatPanel(file, options);
  const result = await Tesseract.recognize(processed.processedImageUrl, "chi_sim+eng", {
    logger: (message) => {
      if (message.status) {
        onProgress?.({
          status: message.status,
          progress: message.progress ?? 0,
        });
      }
    },
  });

  return {
    ...processed,
    text: result.data.text,
  };
}

export function extractMatchDraftFromText(text: string): Partial<MatchDraft> {
  const lines = toCleanLines(text);
  const compactText = lines.join("\n");
  const draft: Partial<MatchDraft> = { ...emptyDraft };

  parseKillAssistKnock(lines, compactText, draft);
  parseDamage(lines, compactText, draft);
  parseSurvivalTime(lines, compactText, draft);

  return draft;
}

async function preprocessStatPanel(file: File, options: RecognizeImageOptions): Promise<Omit<OcrResult, "text">> {
  const bitmap = await createImageBitmap(file);
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  const shouldCropStatsPanel = options.cropMode !== "none";
  const crop = shouldCropStatsPanel ? chooseStatsCrop(bitmap.width, bitmap.height) : chooseFullImageCrop(bitmap.width, bitmap.height);
  const scale = chooseScale(crop.width, shouldCropStatsPanel);
  const canvas = document.createElement("canvas");
  const width = Math.round(crop.width * scale);
  const height = Math.round(crop.height * scale);
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Canvas is not available for OCR preprocessing.");
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);

  const imageData = context.getImageData(0, 0, width, height);
  const threshold = getOtsuThreshold(imageData);

  for (let index = 0; index < imageData.data.length; index += 4) {
    const red = imageData.data[index];
    const green = imageData.data[index + 1];
    const blue = imageData.data[index + 2];
    const gray = getEnhancedGray(red, green, blue);
    const value = gray >= threshold ? 0 : 255;

    imageData.data[index] = value;
    imageData.data[index + 1] = value;
    imageData.data[index + 2] = value;
    imageData.data[index + 3] = 255;
  }

  context.putImageData(imageData, 0, 0);
  bitmap.close();

  return {
    processedImageUrl: canvas.toDataURL("image/png"),
    crop,
    source: {
      width: sourceWidth,
      height: sourceHeight,
    },
  };
}

function chooseFullImageCrop(width: number, height: number) {
  return {
    x: 0,
    y: 0,
    width,
    height,
  };
}

function chooseStatsCrop(width: number, height: number) {
  const aspect = width / height;
  const cropRatio = aspect > 1.1 ? 0.34 : aspect >= 0.62 ? 0.49 : 1;

  return {
    x: 0,
    y: 0,
    width: Math.round(width * cropRatio),
    height,
  };
}

function chooseScale(cropWidth: number, shouldCropStatsPanel: boolean) {
  if (!shouldCropStatsPanel && cropWidth > 900) {
    return 1;
  }
  if (cropWidth < 260) {
    return 4;
  }
  if (cropWidth < 520) {
    return 3;
  }
  return 2;
}

function getEnhancedGray(red: number, green: number, blue: number) {
  const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
  const orangeTextBoost = red > 150 && green > 55 && red > blue * 1.35 ? red * 0.88 : 0;
  return Math.max(luminance, orangeTextBoost);
}

function getOtsuThreshold(imageData: ImageData) {
  const histogram = new Array<number>(256).fill(0);
  const totalPixels = imageData.width * imageData.height;

  for (let index = 0; index < imageData.data.length; index += 4) {
    const gray = Math.round(getEnhancedGray(imageData.data[index], imageData.data[index + 1], imageData.data[index + 2]));
    histogram[gray] += 1;
  }

  let total = 0;
  for (let value = 0; value < 256; value += 1) {
    total += value * histogram[value];
  }

  let backgroundWeight = 0;
  let backgroundSum = 0;
  let maxVariance = 0;
  let threshold = 120;

  for (let value = 0; value < 256; value += 1) {
    backgroundWeight += histogram[value];
    if (backgroundWeight === 0) {
      continue;
    }

    const foregroundWeight = totalPixels - backgroundWeight;
    if (foregroundWeight === 0) {
      break;
    }

    backgroundSum += value * histogram[value];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (total - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;

    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = value;
    }
  }

  return Math.min(Math.max(threshold + 8, 88), 176);
}

function toCleanLines(text: string) {
  return text
    .replace(/[|]/g, "/")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function parseKillAssistKnock(lines: string[], compactText: string, draft: Partial<MatchDraft>) {
  const labelAndValue = compactText.match(/击杀\s*\/?\s*助攻\s*\/?\s*击倒[\s\S]{0,30}?(\d+)\s*[/／]\s*(\d+)\s*[/／]\s*(\d+)/);
  const looseTriplet = lines.find((line) => /^\d+\s*[/／]\s*\d+\s*[/／]\s*\d+$/.test(line));
  const values = labelAndValue?.slice(1, 4) ?? looseTriplet?.match(/\d+/g);

  if (!values || values.length < 3) {
    return;
  }

  draft.kills = values[0];
  draft.assists = values[1];
  draft.knocks = values[2];
}

function parseDamage(lines: string[], compactText: string, draft: Partial<MatchDraft>) {
  const labeledDamage = compactText.match(/(?:造成伤害|造成伤|伤害)[^\d]{0,12}(\d[\d,]*)/);
  const value = labeledDamage?.[1] ?? findValueAfterLabel(lines, ["造成伤害", "造成伤", "伤害"], /^\d[\d,]*$/);

  if (value) {
    draft.damage = value;
  }
}

function parseSurvivalTime(lines: string[], compactText: string, draft: Partial<MatchDraft>) {
  const labeledTime = compactText.match(/(?:生存时间|存活时间|生存)[^\d]{0,12}(\d{1,2}:\d{2}(?::\d{2})?)/);
  const value = labeledTime?.[1] ?? findValueAfterLabel(lines, ["生存时间", "存活时间", "生存"], /^\d{1,2}:\d{2}(?::\d{2})?$/);

  if (value) {
    draft.survivalTime = value;
  }
}

function findValueAfterLabel(lines: string[], labels: string[], valuePattern: RegExp) {
  const labelIndex = lines.findIndex((line) => hasAnyLabel(line, labels));
  if (labelIndex === -1) {
    return "";
  }

  for (const line of lines.slice(labelIndex + 1, labelIndex + 4)) {
    const value = line.match(valuePattern)?.[0];
    if (value) {
      return value;
    }
  }

  return "";
}

function hasAnyLabel(line: string, labels: string[]) {
  return labels.some((label) => line.includes(label));
}
