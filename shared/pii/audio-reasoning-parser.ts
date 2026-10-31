import { anonymizePii, deanonymizePii, type PiiTokenMap } from "./anonymizer";
import type { MeridianStreamEvent } from "./audio-stream";

/**
 * Parses a combined model stream carrying embedded <thought>...</thought> blocks,
 * tool calls (<tool_call name="...">...</tool_call>), and markdown output.
 * Demultiplexes into clean Working/Reasoning stream vs. Tool Call stream vs. Final Output stream.
 * Automatically applies the agnostic PII layer to output and tool calls.
 */
export class AudioReasoningParser {
  private buffer = "";
  private state: "output" | "thought" | "tool_call" = "output";
  private activeToolName = "";
  private tokenMap: PiiTokenMap = {};

  constructor(tokenMap: PiiTokenMap = {}) {
    this.tokenMap = tokenMap;
  }

  setTokenMap(tokenMap: PiiTokenMap): void {
    this.tokenMap = { ...this.tokenMap, ...tokenMap };
  }

  /**
   * Push an incoming token chunk from the audio-native model.
   * Emits demultiplexed thought, tool call, or clean output events.
   */
  pushChunk(rawChunk: string): MeridianStreamEvent[] {
    const events: MeridianStreamEvent[] = [];
    this.buffer += rawChunk;

    while (this.buffer.length > 0) {
      if (this.state === "output") {
        // Look for next tag
        const thoughtStart = this.buffer.indexOf("<thought>");
        const toolStart = this.buffer.indexOf("<tool_call");

        // Determine which tag appears earlier
        let nextTagIndex = -1;
        let tagType: "thought" | "tool_call" | null = null;

        if (thoughtStart !== -1 && toolStart !== -1) {
          if (thoughtStart < toolStart) {
            nextTagIndex = thoughtStart;
            tagType = "thought";
          } else {
            nextTagIndex = toolStart;
            tagType = "tool_call";
          }
        } else if (thoughtStart !== -1) {
          nextTagIndex = thoughtStart;
          tagType = "thought";
        } else if (toolStart !== -1) {
          nextTagIndex = toolStart;
          tagType = "tool_call";
        }

        if (nextTagIndex === -1) {
          // Check if partial tag is forming at end of buffer
          const possibleTag = this.buffer.lastIndexOf("<");
          if (possibleTag !== -1 && possibleTag > this.buffer.length - 12) {
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

          // Full buffer is clean output
          const clean = deanonymizePii(this.buffer, this.tokenMap);
          events.push({
            type: "output_chunk",
            delta: clean,
            timestampMs: Date.now(),
          });
          this.buffer = "";
        } else {
          // Flush content preceding the tag
          if (nextTagIndex > 0) {
            const before = this.buffer.slice(0, nextTagIndex);
            const clean = deanonymizePii(before, this.tokenMap);
            events.push({
              type: "output_chunk",
              delta: clean,
              timestampMs: Date.now(),
            });
          }

          if (tagType === "thought") {
            this.state = "thought";
            this.buffer = this.buffer.slice(nextTagIndex + "<thought>".length);
          } else if (tagType === "tool_call") {
            const tagClose = this.buffer.indexOf(">", nextTagIndex);
            if (tagClose === -1) {
              // Opening tag not yet fully received (e.g. `<tool_call name="ask_a`)
              this.buffer = this.buffer.slice(nextTagIndex);
              break;
            }

            const openTag = this.buffer.slice(nextTagIndex, tagClose + 1);
            const nameMatch = openTag.match(/name=["']([^"']+)["']/i);
            this.activeToolName = nameMatch ? nameMatch[1] : "unknown";
            this.state = "tool_call";
            this.buffer = this.buffer.slice(tagClose + 1);
          }
        }
      } else if (this.state === "thought") {
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
          this.state = "output";
          this.buffer = this.buffer.slice(thoughtEnd + "</thought>".length);
        }
      } else if (this.state === "tool_call") {
        const toolEnd = this.buffer.indexOf("</tool_call>");
        if (toolEnd === -1) {
          const possibleTag = this.buffer.lastIndexOf("<");
          if (possibleTag !== -1 && possibleTag > this.buffer.length - 12) {
            const safeArgs = this.buffer.slice(0, possibleTag);
            this.buffer = this.buffer.slice(possibleTag);
            if (safeArgs) {
              const cleanArgs = deanonymizePii(safeArgs, this.tokenMap);
              events.push({
                type: "tool_call_chunk",
                tool: this.activeToolName,
                argsDelta: cleanArgs,
              });
            }
            break;
          }

          const cleanArgs = deanonymizePii(this.buffer, this.tokenMap);
          events.push({
            type: "tool_call_chunk",
            tool: this.activeToolName,
            argsDelta: cleanArgs,
          });
          this.buffer = "";
        } else {
          const argsContent = this.buffer.slice(0, toolEnd);
          if (argsContent) {
            const cleanArgs = deanonymizePii(argsContent, this.tokenMap);
            events.push({
              type: "tool_call_chunk",
              tool: this.activeToolName,
              argsDelta: cleanArgs,
            });
          }
          this.state = "output";
          this.activeToolName = "";
          this.buffer = this.buffer.slice(toolEnd + "</tool_call>".length);
        }
      }
    }

    return events;
  }

  flush(): MeridianStreamEvent[] {
    const events: MeridianStreamEvent[] = [];
    if (this.buffer.length > 0) {
      if (this.state === "thought") {
        events.push({
          type: "thought_chunk",
          delta: this.buffer,
          timestampMs: Date.now(),
        });
      } else if (this.state === "tool_call") {
        const cleanArgs = deanonymizePii(this.buffer, this.tokenMap);
        events.push({
          type: "tool_call_chunk",
          tool: this.activeToolName || "unknown",
          argsDelta: cleanArgs,
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
    this.state = "output";
    this.activeToolName = "";
    events.push({ type: "done", status: "completed" });
    return events;
  }
}
