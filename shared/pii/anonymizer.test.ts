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

test("anonymizes credit cards and ssn with reversible tokens", () => {
  const input = "SSN: 123-45-6789 Card: 4111111111111111";
  const result = anonymizePii(input);

  expect(result.detectedTypes).toContain("SSN");
  expect(result.detectedTypes).toContain("CREDIT_CARD");
  expect(result.anonymizedText).not.toContain("123-45-6789");
  expect(result.anonymizedText).not.toContain("4111111111111111");

  const restored = deanonymizePii(result.anonymizedText, result.tokenMap);
  expect(restored).toBe(input);
});

test("handles empty or benign input without modification", () => {
  const benign = "Hello world, this is a clean query without any secret.";
  const result = anonymizePii(benign);
  expect(result.anonymizedText).toBe(benign);
  expect(result.detectedTypes.length).toBe(0);
  expect(Object.keys(result.tokenMap).length).toBe(0);
});
