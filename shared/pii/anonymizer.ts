export type PiiEntityType =
  | "EMAIL"
  | "CREDIT_CARD"
  | "SSN"
  | "PHONE_NUMBER"
  | "IP_ADDRESS"
  | "API_KEY";

export type PiiTokenMap = Record<string, string>;

export interface AnonymizeResult {
  anonymizedText: string;
  tokenMap: PiiTokenMap;
  detectedTypes: PiiEntityType[];
}

export interface PiiFilterOptions {
  reversible?: boolean;
  detectEntities?: PiiEntityType[];
}

/**
 * Standard regex patterns for deterministic, zero-dependency, ultra-fast PII detection.
 * Order matters: check more specific formats (like CREDIT_CARD and SSN) before looser ones (PHONE_NUMBER).
 */
const PII_PATTERNS: Record<PiiEntityType, RegExp> = {
  EMAIL: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  CREDIT_CARD: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
  SSN: /\b\d{3}-\d{2}-\d{4}\b/g,
  PHONE_NUMBER: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g,
  IP_ADDRESS: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
  API_KEY: /\b(?:sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|AIza[0-9A-Za-z-_]{35})\b/g,
};

/**
 * Agnostic PII Anonymizer: Masks sensitive user entities with reversible tokens.
 */
export function anonymizePii(
  text: string,
  options: PiiFilterOptions = {},
): AnonymizeResult {
  if (!text) {
    return { anonymizedText: "", tokenMap: {}, detectedTypes: [] };
  }

  const tokenMap: PiiTokenMap = {};
  const detectedTypes = new Set<PiiEntityType>();
  let anonymizedText = text;
  let counter = 1;

  const entityTypes =
    options.detectEntities ?? (Object.keys(PII_PATTERNS) as PiiEntityType[]);

  for (const type of entityTypes) {
    const pattern = PII_PATTERNS[type];
    if (!pattern) continue;

    pattern.lastIndex = 0;

    anonymizedText = anonymizedText.replace(pattern, (match) => {
      detectedTypes.add(type);
      const token = `<PII_${type}_${counter++}>`;
      tokenMap[token] = match;
      return token;
    });
  }

  return {
    anonymizedText,
    tokenMap,
    detectedTypes: Array.from(detectedTypes),
  };
}

/**
 * Reverses anonymization by restoring raw values from the token map.
 */
export function deanonymizePii(
  text: string,
  tokenMap: PiiTokenMap,
): string {
  if (!text || !tokenMap || Object.keys(tokenMap).length === 0) {
    return text;
  }

  let restored = text;
  for (const [token, original] of Object.entries(tokenMap)) {
    restored = restored.replaceAll(token, original);
  }
  return restored;
}
