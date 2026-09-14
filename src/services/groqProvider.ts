/**
 * Groq uses the standard Chat Completions protocol. Reuse the existing
 * hardened OpenAI-compatible transport while keeping the provider name
 * distinct in configuration and client-visible status.
 */
import {
  createOpenRouterProvider,
  type OpenRouterProviderOptions,
} from "./openrouterProvider.js";
import type { AgentProvider } from "./provider.js";

export type GroqProviderOptions = OpenRouterProviderOptions;

export function createGroqProvider(options: GroqProviderOptions): AgentProvider {
  return createOpenRouterProvider(options);
}
