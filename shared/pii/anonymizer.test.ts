import { expect, test } from "bun:test";
import { anonymizePii, deanonymizePii } from "./anonymizer";

test("anonymizes email and phone numbers accurately", () => {
  const input = "Contact John Doe at john.doe@example.com or +1 555-234-5678.";
  const result = anonymizePii(input);

  expect(result.detectedTypes).toContain("EMAIL");
  expect(result.detectedTypes).toContain("PHONE_NUMBER");
  expect(result.anonymizedText).not.toContain("john.doe@example.com");
  expect(result.anonymizedText).not.toContain("+1 555-234-5678");

  const restored = deanonymizePii(result.anonymizedText, result.tokenMap);
  expect(restored).toBe(input);
});

test("anonymizes formatted credit cards and ssn with reversible tokens", () => {
  const input = "SSN: 123-45-6789 Card: 4111 1111-1111 1111";
  const result = anonymizePii(input);

  expect(result.detectedTypes).toContain("SSN");
  expect(result.detectedTypes).toContain("CREDIT_CARD");
  expect(result.anonymizedText).not.toContain("123-45-6789");
  expect(result.anonymizedText).not.toContain("4111 1111-1111 1111");

  const restored = deanonymizePii(result.anonymizedText, result.tokenMap);
  expect(restored).toBe(input);
});

test("masks valid IPv6 addresses and leaves invalid addresses and non-card numbers alone", () => {
  const input =
    "Server 2001:db8::1 is reachable; 2001:db8::zz is not. Reference 1234567890123456 is not a valid card.";
  const result = anonymizePii(input);

  expect(result.detectedTypes).toContain("IP_ADDRESS");
  expect(result.detectedTypes).not.toContain("CREDIT_CARD");
  expect(result.anonymizedText).not.toContain("2001:db8::1");
  expect(result.anonymizedText).toContain("2001:db8::zz");
  expect(result.anonymizedText).toContain("1234567890123456");
  expect(deanonymizePii(result.anonymizedText, result.tokenMap)).toBe(input);
});

test("masks IPv4 addresses and current API key prefixes", () => {
  const input =
    "Use host 192.168.1.10 with key sk-proj-12345678901234567890 or ghp_123456789012345678901234567890123456.";
  const result = anonymizePii(input);

  expect(result.detectedTypes).toContain("IP_ADDRESS");
  expect(result.detectedTypes).toContain("API_KEY");
  expect(result.anonymizedText).not.toContain("192.168.1.10");
  expect(result.anonymizedText).not.toContain("sk-proj-12345678901234567890");
  expect(result.anonymizedText).not.toContain(
    "ghp_123456789012345678901234567890123456",
  );
  expect(deanonymizePii(result.anonymizedText, result.tokenMap)).toBe(input);
});

test("handles empty or benign input without modification", () => {
  const benign = "Hello world, this is a clean query without any secret.";
  const result = anonymizePii(benign);
  expect(result.anonymizedText).toBe(benign);
  expect(result.detectedTypes.length).toBe(0);
  expect(Object.keys(result.tokenMap).length).toBe(0);
});

test("does not reinterpret token-shaped text already present in the input", () => {
  const input =
    "Keep <PII_EMAIL_1> as written; contact jane@example.com instead.";
  const result = anonymizePii(input);

  expect(result.anonymizedText).toContain("<PII_EMAIL_1>");
  expect(result.anonymizedText).toContain("<PII_EMAIL_2>");
  expect(deanonymizePii(result.anonymizedText, result.tokenMap)).toBe(input);
});
