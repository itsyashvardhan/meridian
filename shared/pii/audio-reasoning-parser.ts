import { anonymizePii, deanonymizePii, type PiiTokenMap } from "./anonymizer";
import type { MeridianStreamEvent } from "./audio-stream";

/**
 * Parses a combined model stream carrying embedded <thought>...</thought> blocks
 * and demultiplexes into clean Working/Reasoning stream vs. Final Output stream.
 * Automatically applies the agnostic PII layer to both streams.
 */
export class AudioReasoningParser {
  private buffer = "";
  private insideThought = false;
  private tokenMap: PiiTokenMap = {};

  constructor(tokenMap: PiiTokenMap = {}) {
    this.tokenMap = tokenMap;
  }

  setTokenMap(tokenMap: PiiTokenMap): void {
    this.tokenMap = { ...this.tokenMap, ...tokenMap };
  }

  /**
   * Push an incoming token chunk from the audio-native model.
   * Emits demultiplexed thought or output events.
   */
  pushChunk(rawChunk: string): MeridianStreamEvent[] {
    const events: MeridianStreamEvent[] = [];
    this.buffer += rawChunk;

    while (this.buffer.length > 0) {
      if (!this.insideThought) {
        const thoughtStart = this.buffer.indexOf("<thought>");
        if (thoughtStart === -1) {
          // Check if partial tag is forming at the end (e.g. "<th")
          const possibleTag = this.buffer.lastIndexOf("<");
          if (possibleTag !== -1 && possibleTag > this.buffer.length - 9) {
            const safeOutput = this.buffer.slice(0, possibleTag);
            this.buffer = this.buffer.slice(possibleTag);
            if (safeOutput) {
              const clean = deanonymizePii(safeOutput, this.tokenMap);
              events.push({
                type: "output_chunk",
                delta: clean,
                timestampMs: Date.now(),
              });
            }
            break;
          }

          // Everything currently in buffer is clean output
          const clean = deanonymizePii(this.buffer, this.tokenMap);
          events.push({
            type: "output_chunk",
            delta: clean,
            timestampMs: Date.now(),
          });
          this.buffer = "";
        } else {
          // Output before thought tag
          if (thoughtStart > 0) {
            const before = this.buffer.slice(0, thoughtStart);
            const clean = deanonymizePii(before, this.tokenMap);
            events.push({
              type: "output_chunk",
              delta: clean,
              timestampMs: Date.now(),
            });
          }
          this.insideThought = true;
          this.buffer = this.buffer.slice(thoughtStart + "<thought>".length);
        }
      } else {
        const thoughtEnd = this.buffer.indexOf("</thought>");
        if (thoughtEnd === -1) {
          const possibleTag = this.buffer.lastIndexOf("<");
          if (possibleTag !== -1 && possibleTag > this.buffer.length - 10) {
            const safeThought = this.buffer.slice(0, possibleTag);
            this.buffer = this.buffer.slice(possibleTag);
            if (safeThought) {
              events.push({
                type: "thought_chunk",
                delta: safeThought,
                timestampMs: Date.now(),
              });
            }
            break;
          }

          events.push({
            type: "thought_chunk",
            delta: this.buffer,
            timestampMs: Date.now(),
          });
          this.buffer = "";
        } else {
          const thoughtContent = this.buffer.slice(0, thoughtEnd);
          if (thoughtContent) {
            events.push({
              type: "thought_chunk",
              delta: thoughtContent,
              timestampMs: Date.now(),
            });
          }
          this.insideThought = false;
          this.buffer = this.buffer.slice(thoughtEnd + "</thought>".length);
        }
      }
    }

    return events;
  }

  flush(): MeridianStreamEvent[] {
    const events: MeridianStreamEvent[] = [];
    if (this.buffer.length > 0) {
      if (this.insideThought) {
        events.push({
          type: "thought_chunk",
          delta: this.buffer,
          timestampMs: Date.now(),
        });
      } else {
        const clean = deanonymizePii(this.buffer, this.tokenMap);
        events.push({
          type: "output_chunk",
          delta: clean,
          timestampMs: Date.now(),
        });
      }
      this.buffer = "";
    }
    events.push({ type: "done", status: "completed" });
    return events;
  }
}
