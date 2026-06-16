/*
 * lib/providers — LLM provider abstraction (NOT implemented in M1).
 * -----------------------------------------------------------------------------
 * Phase 1 ships an Anthropic implementation only, but the interface is shaped so
 * OpenAI / Gemini / local adapters can drop in later (P2). No provider code,
 * keys, or network calls exist in M1 — this only sketches the contract.
 * -----------------------------------------------------------------------------
 */

// Placeholder contract sketch for M2. Intentionally not exported/used in M1.
//
//   export interface Provider {
//     validateKey(): Promise<boolean>;
//     stream(messages: Message[], tools: ToolSpec[]): AsyncIterable<Delta>;
//   }
//
//   // anthropic.ts — BYO-key Anthropic Messages API streaming impl (M2)

export {};
