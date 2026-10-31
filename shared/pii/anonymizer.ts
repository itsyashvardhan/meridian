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
  CREDIT_CARD: /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g,
  SSN: /\b\d{3}-\d{2}-\d{4}\b/g,
  PHONE_NUMBER: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g,
  IP_ADDRESS:
    /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b|(?<![A-Za-z0-9:])(?=[0-9A-Fa-f:]*:)[0-9A-Fa-f:]{3,}(?![A-Za-z0-9:])/g,
  API_KEY:
    /\b(?:sk-[a-zA-Z0-9_-]{20,}|ghp_[a-zA-Z0-9]{20,}|AIza[0-9A-Za-z-_]{35})\b/g,
};

function supportedCardNumber(value: string): boolean {
  const digits = value.replace(/[ -]/g, "");
  const supportedFormat =
    /^(?:4\d{12}(?:\d{3})?|5[1-5]\d{14}|2(?:2(?:2[1-9]|[3-9]\d)|[3-6]\d{2}|7(?:[01]\d|20))\d{12}|3[47]\d{13}|6011\d{12}|65\d{14}|64[4-9]\d{13})$/.test(
      digits,
    );
  if (!supportedFormat) return false;

  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index--) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function validIpv6(value: string): boolean {
  try {
    return new URL(`http://[${value}]/`).hostname.startsWith("[");
  } catch {
    return false;
  }
}

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
      if (type === "CREDIT_CARD" && !supportedCardNumber(match)) return match;
      if (type === "IP_ADDRESS" && match.includes(":") && !validIpv6(match))
        return match;
      detectedTypes.add(type);
      // Do not claim a placeholder that was already part of the user's text. Otherwise
      // deanonymization would silently replace that literal text with the matched value.
      let token = `<PII_${type}_${counter++}>`;
      while (text.includes(token) || tokenMap[token] !== undefined) {
        token = `<PII_${type}_${counter++}>`;
      }
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
export function deanonymizePii(text: string, tokenMap: PiiTokenMap): string {
  if (!text || !tokenMap || Object.keys(tokenMap).length === 0) {
    return text;
  }

  let restored = text;
  for (const [token, original] of Object.entries(tokenMap)) {
    restored = restored.replaceAll(token, original);
  }
  return restored;
}
