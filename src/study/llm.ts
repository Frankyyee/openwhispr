import reasoningService from "../services/ReasoningService";
import {
  getSettings,
  selectIsCloudNoteFormattingMode,
  selectResolvedNoteFormatting,
} from "../stores/settingsStore";
import { buildNoteFormattingOverrides } from "../helpers/noteFormattingOverrides";
import type { LLM } from "./types";

/**
 * Study mode runs on the "Note formatting" model from Settings → AI Models, so any
 * provider OpenWhispr supports (OpenWhispr Cloud, Claude, OpenAI, Gemini, Groq,
 * local GGUF, self-hosted) can judge answers and ask questions.
 */
export function createStudyLLM(): LLM {
  return async (system, user) => {
    const settings = getSettings();
    const noteFormatting = selectResolvedNoteFormatting(settings);
    const isCloud = selectIsCloudNoteFormattingMode(settings);
    return reasoningService.processText(user, noteFormatting.model, null, {
      systemPrompt: system,
      maxTokens: 1500,
      temperature: 0.2,
      disableThinking: true,
      ...buildNoteFormattingOverrides(noteFormatting, isCloud),
    });
  };
}

export function isStudyLLMConfigured(): boolean {
  const settings = getSettings();
  return (
    selectIsCloudNoteFormattingMode(settings) || !!selectResolvedNoteFormatting(settings).model
  );
}
