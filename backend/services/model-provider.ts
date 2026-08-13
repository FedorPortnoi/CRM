// ---------------------------------------------------------------------------
// The one seam that decides which model client serves a completion.
//
// MODEL_PROVIDER (read through model-jurisdiction.ts, so the jurisdiction gate
// and this router can never disagree about who the provider is):
//
//   'yandex_foundation_models'  → yandex-gpt.ts   (domestic; the default)
//   'openai'                    → openai-gpt.ts   (foreign, via workers/openai-proxy)
//   anything else               → fails closed as not-configured
//
// Deliberately NOT a registry: a new provider must be added here by hand, in
// the same commit that decides whether it belongs in DOMESTIC_PROVIDERS —
// which is the decision that switches contact aliasing on or off. An unknown
// string silently defaulting to any client would make that decision for you.
// ---------------------------------------------------------------------------

import { currentModelProvider } from './model-jurisdiction';
import * as yandex from './yandex-gpt';
import * as openai from './openai-gpt';
import type { AiCompletionInput, AiError, AiResult } from './yandex-gpt';

export const YANDEX_PROVIDER = 'yandex_foundation_models';
export const OPENAI_PROVIDER = 'openai';

export function isModelProviderConfigured(): boolean {
  switch (currentModelProvider()) {
    case YANDEX_PROVIDER:
      return yandex.isYandexGptConfigured();
    case OPENAI_PROVIDER:
      return openai.isOpenAiGptConfigured();
    default:
      return false;
  }
}

export function modelProviderNotConfiguredError(): AiError {
  switch (currentModelProvider()) {
    case YANDEX_PROVIDER:
      return yandex.serviceNotConfiguredError();
    case OPENAI_PROVIDER:
      return openAiNotConfigured();
    default:
      return unknownProviderError();
  }
}

export async function createCompletion(input: AiCompletionInput): Promise<AiResult> {
  switch (currentModelProvider()) {
    case YANDEX_PROVIDER:
      return yandex.createCompletion(input);
    case OPENAI_PROVIDER:
      return openai.createCompletion(input);
    default:
      return { ok: false, error: unknownProviderError() };
  }
}

function openAiNotConfigured(): AiError {
  return openai.openAiNotConfiguredError();
}

function unknownProviderError(): AiError {
  return {
    code: 'SERVICE_NOT_CONFIGURED',
    message:
      `MODEL_PROVIDER="${currentModelProvider()}" is not a known provider. ` +
      'Use "yandex_foundation_models" or "openai" (see backend/services/model-provider.ts).',
  };
}
