import {
  AnthropicProvider as AnthropicSDKProvider,
  AnthropicProviderOptions,
  createAnthropic,
} from '@ai-sdk/anthropic';
import { AISDKError, generateText, streamText } from 'ai';

import {
  CopilotProviderSideError,
  metrics,
  UserFriendlyError,
} from '../../../base';
import { createExaCrawlTool, createExaSearchTool } from '../tools';
import { CopilotProvider } from './provider';
import type {
  CopilotChatOptions,
  ModelConditions,
  PromptMessage,
} from './types';
import { CopilotProviderType, ModelInputType, ModelOutputType } from './types';
import { chatToGPTMessage } from './utils';

export type AnthropicConfig = {
  apiKey: string;
  baseUrl?: string;
};

export class AnthropicProvider extends CopilotProvider<AnthropicConfig> {
  override readonly type = CopilotProviderType.Anthropic;
  override readonly models = [
    {
      id: 'claude-3-7-sonnet-20250219',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [ModelOutputType.Text],
          defaultForOutputType: true,
        },
      ],
    },
    {
      id: 'claude-3-5-sonnet-20241022',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [ModelOutputType.Text],
        },
      ],
    },
  ];

  private readonly MAX_STEPS = 20;

  private readonly CALLOUT_PREFIX = '\n> [!]\n> ';

  #instance!: AnthropicSDKProvider;

  override configured(): boolean {
    return !!this.config.apiKey;
  }

  protected override setup() {
    super.setup();
    this.#instance = createAnthropic({
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
        message: e?.message || 'Unexpected anthropic response',
      });
    }
  }

  async text(
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
      const { text, reasoning } = await generateText({
        model: modelInstance,
        system,
        messages: msgs,
        abortSignal: options.signal,
        providerOptions: {
          anthropic: this.getAnthropicOptions(options, model.id),
        },
        tools: this.getTools(),
        maxSteps: this.MAX_STEPS,
        experimental_continueSteps: true,
      });

      if (!text) throw new Error('Failed to generate text');

      return reasoning ? `${reasoning}\n${text}` : text;
    } catch (e: any) {
      metrics.ai.counter('chat_text_errors').add(1, { model: model.id });
      throw this.handleError(e);
    }
  }

  async *streamText(
    cond: ModelConditions,
    messages: PromptMessage[],
    options: CopilotChatOptions = {}
  ): AsyncIterable<string> {
    const fullCond = { ...cond, outputType: ModelOutputType.Text };
    await this.checkParams({ cond: fullCond, messages, options });
    const model = this.selectModel(fullCond);

    try {
      metrics.ai.counter('chat_text_stream_calls').add(1, { model: model.id });
      const [system, msgs] = await chatToGPTMessage(messages);
      const { fullStream } = streamText({
        model: this.#instance(model.id),
        system,
        messages: msgs,
        abortSignal: options.signal,
        providerOptions: {
          anthropic: this.getAnthropicOptions(options, model.id),
        },
        tools: this.getTools(),
        maxSteps: this.MAX_STEPS,
        experimental_continueSteps: true,
      });

      let lastType;
      // reasoning, tool-call, tool-result need to mark as callout
      let prefix: string | null = this.CALLOUT_PREFIX;
      for await (const chunk of fullStream) {
        switch (chunk.type) {
          case 'text-delta': {
            if (!prefix) {
              prefix = this.CALLOUT_PREFIX;
            }
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
          case 'tool-call': {
            if (prefix) {
              yield prefix;
              prefix = null;
            }
            if (chunk.toolName === 'web_search_exa') {
              yield this.markAsCallout(
                `\nSearching the web "${chunk.args.query}"\n`
              );
            }
            if (chunk.toolName === 'web_crawl_exa') {
              yield this.markAsCallout(
                `\nCrawling the web "${chunk.args.url}"\n`
              );
            }
            break;
          }
          case 'tool-result': {
            if (
              chunk.toolName === 'web_search_exa' &&
              Array.isArray(chunk.result)
            ) {
              if (prefix) {
                yield prefix;
                prefix = null;
              }
              yield this.markAsCallout(this.getWebSearchLinks(chunk.result));
            }
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
    } catch (e: any) {
      metrics.ai.counter('chat_text_stream_errors').add(1, { model: model.id });
      throw this.handleError(e);
    }
  }

  private getTools() {
    return {
      web_search_exa: createExaSearchTool(this.AFFiNEConfig),
      web_crawl_exa: createExaCrawlTool(this.AFFiNEConfig),
    };
  }

  private getAnthropicOptions(options: CopilotChatOptions, model: string) {
    const result: AnthropicProviderOptions = {};
    if (options?.reasoning && this.isReasoningModel(model)) {
      result.thinking = {
        type: 'enabled',
        budgetTokens: 12000,
      };
    }
    return result;
  }

  private getWebSearchLinks(
    list: {
      title: string | null;
      url: string;
    }[]
  ): string {
    const links = list.reduce((acc, result) => {
      return acc + `\n[${result.title ?? result.url}](${result.url})\n\n`;
    }, '');
    return links;
  }

  private markAsCallout(text: string) {
    return text.replaceAll('\n', '\n> ');
  }

  private isReasoningModel(model: string) {
    // only claude 3.7 sonnet supports reasoning config
    return model.startsWith('claude-3-7-sonnet');
  }
}
