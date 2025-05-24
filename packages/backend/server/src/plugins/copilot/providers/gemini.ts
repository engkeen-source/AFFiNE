import {
  createGoogleGenerativeAI,
  type GoogleGenerativeAIProvider,
  type GoogleGenerativeAIProviderOptions,
} from '@ai-sdk/google';
import {
  AISDKError,
  generateObject,
  generateText,
  JSONParseError,
  streamText,
} from 'ai';

import {
  CopilotPromptInvalid,
  CopilotProviderSideError,
  metrics,
  UserFriendlyError,
} from '../../../base';
import { CopilotProvider } from './provider';
import type {
  CopilotChatOptions,
  CopilotImageOptions,
  ModelConditions,
  PromptMessage,
} from './types';
import { CopilotProviderType, ModelInputType, ModelOutputType } from './types';
import { chatToGPTMessage } from './utils';

export const DEFAULT_DIMENSIONS = 256;

export type GeminiConfig = {
  apiKey: string;
  baseUrl?: string;
};

export class GeminiProvider extends CopilotProvider<GeminiConfig> {
  override readonly type = CopilotProviderType.Gemini;

  readonly models = [
    {
      name: 'Gemini 2.0 Flash',
      id: 'gemini-2.0-flash-001',
      capabilities: [
        {
          input: [
            ModelInputType.Text,
            ModelInputType.Image,
            ModelInputType.Audio,
          ],
          output: [ModelOutputType.Text, ModelOutputType.Structured],
          defaultForOutputType: true,
        },
      ],
    },
    {
      name: 'Gemini 2.5 Flash',
      id: 'gemini-2.5-flash-preview-04-17',
      capabilities: [
        {
          input: [
            ModelInputType.Text,
            ModelInputType.Image,
            ModelInputType.Audio,
          ],
          output: [ModelOutputType.Text, ModelOutputType.Structured],
        },
      ],
    },
    {
      name: 'Gemini 2.5 Pro',
      id: 'gemini-2.5-pro-preview-05-06',
      capabilities: [
        {
          input: [
            ModelInputType.Text,
            ModelInputType.Image,
            ModelInputType.Audio,
          ],
          output: [ModelOutputType.Text, ModelOutputType.Structured],
        },
      ],
    },
    {
      name: 'Text Embedding 004',
      id: 'text-embedding-004',
      capabilities: [
        {
          input: [ModelInputType.Text],
          output: [ModelOutputType.Embedding],
        },
      ],
    },
  ];

  private readonly MAX_STEPS = 20;

  private readonly CALLOUT_PREFIX = '\n> [!]\n> ';

  #instance!: GoogleGenerativeAIProvider;

  override configured(): boolean {
    return !!this.config.apiKey;
  }

  protected override setup() {
    super.setup();
    this.#instance = createGoogleGenerativeAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseUrl,
    });
  }

  private handleError(e: any) {
    if (e instanceof UserFriendlyError) {
      return e;
    } else if (e instanceof AISDKError) {
      this.logger.error('Throw error from ai sdk:', e);
      return new CopilotProviderSideError({
        provider: this.type,
        kind: e.name || 'unknown',
        message: e.message,
      });
    } else {
      return new CopilotProviderSideError({
        provider: this.type,
        kind: 'unexpected_response',
        message: e?.message || 'Unexpected google response',
      });
    }
  }

  override async text(
    cond: ModelConditions,
    messages: PromptMessage[],
    options: CopilotChatOptions = {}
  ): Promise<string> {
    const fullCond = { ...cond, outputType: ModelOutputType.Text };
    await this.checkParams({ cond: fullCond, messages, options });
    const model = this.selectModel(fullCond);

    try {
      metrics.ai.counter('chat_text_calls').add(1, { model: model.id });

      const [system, msgs] = await chatToGPTMessage(messages);

      const modelInstance = this.#instance(model.id);
      const { text } = await generateText({
        model: modelInstance,
        system,
        messages: msgs,
        abortSignal: options.signal,
      });

      if (!text) throw new Error('Failed to generate text');
      return text.trim();
    } catch (e: any) {
      metrics.ai.counter('chat_text_errors').add(1, { model: model.id });
      throw this.handleError(e);
    }
  }

  override async structure(
    cond: ModelConditions,
    messages: PromptMessage[],
    options: CopilotChatOptions = {}
  ): Promise<string> {
    const fullCond = { ...cond, outputType: ModelOutputType.Structured };
    await this.checkParams({ cond: fullCond, messages, options });
    const model = this.selectModel(fullCond);

    try {
      metrics.ai.counter('chat_text_calls').add(1, { model: model.id });

      const [system, msgs, schema] = await chatToGPTMessage(messages);
      if (!schema) {
        throw new CopilotPromptInvalid('Schema is required');
      }

      const modelInstance = this.#instance(model.id, {
        structuredOutputs: true,
      });
      const { object } = await generateObject({
        model: modelInstance,
        system,
        messages: msgs,
        schema,
        abortSignal: options.signal,
        experimental_repairText: async ({ text, error }) => {
          if (error instanceof JSONParseError) {
            // strange fixed response, temporarily replace it
            const ret = text.replaceAll(/^ny\n/g, ' ').trim();
            if (ret.startsWith('```') || ret.endsWith('```')) {
              return ret
                .replace(/```[\w\s]+\n/g, '')
                .replace(/\n```/g, '')
                .trim();
            }
            return ret;
          }
          return null;
        },
      });

      return JSON.stringify(object);
    } catch (e: any) {
      metrics.ai.counter('chat_text_errors').add(1, { model: model.id });
      throw this.handleError(e);
    }
  }

  override async *streamText(
    cond: ModelConditions,
    messages: PromptMessage[],
    options: CopilotChatOptions | CopilotImageOptions = {}
  ): AsyncIterable<string> {
    const fullCond = { ...cond, outputType: ModelOutputType.Text };
    await this.checkParams({ cond: fullCond, messages, options });
    const model = this.selectModel(fullCond);

    try {
      metrics.ai.counter('chat_text_stream_calls').add(1, { model: model.id });
      const [system, msgs] = await chatToGPTMessage(messages);

      const { fullStream } = streamText({
        model: this.#instance(model.id, {
          useSearchGrounding: this.useSearchGrounding(options),
        }),
        system,
        messages: msgs,
        abortSignal: options.signal,
        maxSteps: this.MAX_STEPS,
        providerOptions: {
          google: this.getGeminiOptions(options, model.id),
        },
      });

      let lastType;
      // reasoning, tool-call, tool-result need to mark as callout
      let prefix: string | null = this.CALLOUT_PREFIX;
      for await (const chunk of fullStream) {
        if (chunk) {
          switch (chunk.type) {
            case 'text-delta': {
              let result = chunk.textDelta;
              if (lastType !== chunk.type) {
                result = '\n\n' + result;
              }
              yield result;
              break;
            }
            case 'reasoning': {
              if (prefix) {
                yield prefix;
                prefix = null;
              }
              let result = chunk.textDelta;
              if (lastType !== chunk.type) {
                result = '\n\n' + result;
              }
              yield this.markAsCallout(result);
              break;
            }
            case 'error': {
              const error = chunk.error as { type: string; message: string };
              throw new Error(error.message);
            }
          }
          if (options.signal?.aborted) {
            await fullStream.cancel();
            break;
          }
          lastType = chunk.type;
        }
      }
    } catch (e: any) {
      metrics.ai.counter('chat_text_stream_errors').add(1, { model: model.id });
      throw this.handleError(e);
    }
  }

  private getGeminiOptions(options: CopilotChatOptions, model: string) {
    const result: GoogleGenerativeAIProviderOptions = {};
    if (options?.reasoning && this.isReasoningModel(model)) {
      result.thinkingConfig = {
        thinkingBudget: 12000,
        includeThoughts: true,
      };
    }
    return result;
  }

  private markAsCallout(text: string) {
    return text.replaceAll('\n', '\n> ');
  }

  private isReasoningModel(model: string) {
    return model.startsWith('gemini-2.5');
  }

  private useSearchGrounding(options: CopilotChatOptions) {
    return options?.tools?.includes('webSearch');
  }
}
