import {
  createOpenAI,
  openai,
  type OpenAIProvider as VercelOpenAIProvider,
  OpenAIResponsesProviderOptions,
} from '@ai-sdk/openai';
import {
  AISDKError,
  embedMany,
  experimental_generateImage as generateImage,
  generateObject,
  generateText,
  streamText,
} from 'ai';

import {
  CopilotPromptInvalid,
  CopilotProviderSideError,
  metrics,
  UserFriendlyError,
} from '../../../base';
import { createExaCrawlTool, createExaSearchTool } from '../tools';
import { CopilotProvider } from './provider';
import type {
  CopilotChatOptions,
  CopilotEmbeddingOptions,
  CopilotImageOptions,
  CopilotStructuredOptions,
  ModelConditions,
  PromptMessage,
} from './types';
import { CopilotProviderType, ModelInputType, ModelOutputType } from './types';
import { chatToGPTMessage, CitationParser } from './utils';

export const DEFAULT_DIMENSIONS = 256;

export type OpenAIConfig = {
  apiKey: string;
  baseUrl?: string;
};

type OpenAITools = {
  web_search_preview: ReturnType<typeof openai.tools.webSearchPreview>;
  web_search_exa: ReturnType<typeof createExaSearchTool>;
  web_crawl_exa: ReturnType<typeof createExaCrawlTool>;
};

export class OpenAIProvider extends CopilotProvider<OpenAIConfig> {
  readonly type = CopilotProviderType.OpenAI;

  readonly models = [
    // Text to Text models
    {
      id: 'gpt-4o',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [ModelOutputType.Text],
        },
      ],
    },
    // FIXME(@darkskygit): deprecated
    {
      id: 'gpt-4o-2024-08-06',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [ModelOutputType.Text],
        },
      ],
    },
    {
      id: 'gpt-4o-mini',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [ModelOutputType.Text],
        },
      ],
    },
    // FIXME(@darkskygit): deprecated
    {
      id: 'gpt-4o-mini-2024-07-18',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [ModelOutputType.Text],
        },
      ],
    },
    {
      id: 'gpt-4.1',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [ModelOutputType.Text],
          defaultForOutputType: true,
        },
      ],
    },
    {
      id: 'gpt-4.1-2025-04-14',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [ModelOutputType.Text],
        },
      ],
    },
    {
      id: 'gpt-4.1-mini',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [ModelOutputType.Text],
        },
      ],
    },
    {
      id: 'o1',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [ModelOutputType.Text],
        },
      ],
    },
    {
      id: 'o3',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [ModelOutputType.Text],
        },
      ],
    },
    {
      id: 'o4-mini',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [ModelOutputType.Text],
        },
      ],
    },
    // Embedding models
    {
      id: 'text-embedding-3-large',
      capabilities: [
        {
          input: [ModelInputType.Text],
          output: [ModelOutputType.Embedding],
          defaultForOutputType: true,
        },
      ],
    },
    {
      id: 'text-embedding-3-small',
      capabilities: [
        {
          input: [ModelInputType.Text],
          output: [ModelOutputType.Embedding],
        },
      ],
    },
    // Image generation models
    {
      id: 'dall-e-3',
      capabilities: [
        {
          input: [ModelInputType.Text],
          output: [ModelOutputType.Image],
        },
      ],
    },
    {
      id: 'gpt-image-1',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [ModelOutputType.Image],
          defaultForOutputType: true,
        },
      ],
    },
  ];

  private readonly MAX_STEPS = 20;

  private readonly CALLOUT_PREFIX = '\n> [!]\n> ';

  #instance!: VercelOpenAIProvider;

  override configured(): boolean {
    return !!this.config.apiKey;
  }

  protected override setup() {
    super.setup();
    this.#instance = createOpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseUrl,
    });
  }

  private handleError(
    e: any,
    model: string,
    options: CopilotImageOptions = {}
  ) {
    if (e instanceof UserFriendlyError) {
      return e;
    } else if (e instanceof AISDKError) {
      if (e.message.includes('safety') || e.message.includes('risk')) {
        metrics.ai
          .counter('chat_text_risk_errors')
          .add(1, { model, user: options.user || undefined });
      }

      return new CopilotProviderSideError({
        provider: this.type,
        kind: e.name || 'unknown',
        message: e.message,
      });
    } else {
      return new CopilotProviderSideError({
        provider: this.type,
        kind: 'unexpected_response',
        message: e?.message || 'Unexpected openai response',
      });
    }
  }

  private getTools(
    options: CopilotChatOptions,
    model: string
  ): Partial<OpenAITools> {
    const tools: Partial<OpenAITools> = {};
    if (options?.tools?.length) {
      for (const tool of options.tools) {
        switch (tool) {
          case 'webSearch': {
            if (this.isReasoningModel(model)) {
              tools.web_search_exa = createExaSearchTool(this.AFFiNEConfig);
              tools.web_crawl_exa = createExaCrawlTool(this.AFFiNEConfig);
            } else {
              tools.web_search_preview = openai.tools.webSearchPreview();
            }
            break;
          }
        }
      }
      return tools;
    }
    return tools;
  }

  async text(
    cond: ModelConditions,
    messages: PromptMessage[],
    options: CopilotChatOptions = {}
  ): Promise<string> {
    const fullCond = {
      ...cond,
      outputType: ModelOutputType.Text,
    };
    await this.checkParams({ messages, cond: fullCond, options });
    const model = this.selectModel(fullCond);

    try {
      metrics.ai.counter('chat_text_calls').add(1, { model: model.id });

      const [system, msgs] = await chatToGPTMessage(messages);

      const modelInstance = this.#instance.responses(model.id);

      const { text } = await generateText({
        model: modelInstance,
        system,
        messages: msgs,
        temperature: options.temperature || 0,
        maxTokens: options.maxTokens || 4096,
        providerOptions: {
          openai: this.getOpenAIOptions(options, model.id),
        },
        tools: this.getTools(options, model.id),
        maxSteps: this.MAX_STEPS,
        abortSignal: options.signal,
      });

      return text.trim();
    } catch (e: any) {
      metrics.ai.counter('chat_text_errors').add(1, { model: model.id });
      throw this.handleError(e, model.id, options);
    }
  }

  async *streamText(
    cond: ModelConditions,
    messages: PromptMessage[],
    options: CopilotChatOptions = {}
  ): AsyncIterable<string> {
    const fullCond = {
      ...cond,
      outputType: ModelOutputType.Text,
    };
    await this.checkParams({ messages, cond: fullCond, options });
    const model = this.selectModel(fullCond);

    try {
      metrics.ai.counter('chat_text_stream_calls').add(1, { model: model.id });
      const [system, msgs] = await chatToGPTMessage(messages);

      const modelInstance = this.#instance.responses(model.id);

      const { fullStream } = streamText({
        model: modelInstance,
        system,
        messages: msgs,
        frequencyPenalty: options.frequencyPenalty || 0,
        presencePenalty: options.presencePenalty || 0,
        temperature: options.temperature || 0,
        maxTokens: options.maxTokens || 4096,
        providerOptions: {
          openai: this.getOpenAIOptions(options, model.id),
        },
        tools: this.getTools(options, model.id) as OpenAITools,
        maxSteps: this.MAX_STEPS,
        abortSignal: options.signal,
      });

      const parser = new CitationParser();
      let lastType;
      // reasoning, tool-call, tool-result need to mark as callout
      let prefix: string | null = this.CALLOUT_PREFIX;
      for await (const chunk of fullStream) {
        if (chunk) {
          switch (chunk.type) {
            case 'text-delta': {
              let result = parser.parse(chunk.textDelta);
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
                yield this.markAsCallout(
                  `\n${this.getWebSearchLinks(chunk.result)}\n`
                );
              }
              break;
            }
            case 'finish': {
              const result = parser.end();
              yield result;
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
      throw this.handleError(e, model.id, options);
    }
  }

  override async structure(
    cond: ModelConditions,
    messages: PromptMessage[],
    options: CopilotStructuredOptions = {}
  ): Promise<string> {
    const fullCond = { ...cond, outputType: ModelOutputType.Structured };
    await this.checkParams({ messages, cond: fullCond, options });
    const model = this.selectModel(fullCond);

    try {
      metrics.ai.counter('chat_text_calls').add(1, { model: model.id });

      const [system, msgs, schema] = await chatToGPTMessage(messages);
      if (!schema) {
        throw new CopilotPromptInvalid('Schema is required');
      }

      const modelInstance = this.#instance.responses(model.id);

      const { object } = await generateObject({
        model: modelInstance,
        system,
        messages: msgs,
        temperature: ('temperature' in options && options.temperature) || 0,
        maxTokens: ('maxTokens' in options && options.maxTokens) || 4096,
        schema,
        providerOptions: {
          openai: options.user ? { user: options.user } : {},
        },
        abortSignal: options.signal,
      });

      return JSON.stringify(object);
    } catch (e: any) {
      metrics.ai.counter('chat_text_errors').add(1, { model: model.id });
      throw this.handleError(e, model.id, options);
    }
  }

  override async *streamImages(
    cond: ModelConditions,
    messages: PromptMessage[],
    options: CopilotImageOptions = {}
  ) {
    const fullCond = { ...cond, outputType: ModelOutputType.Image };
    await this.checkParams({ messages, cond: fullCond, options });
    const model = this.selectModel(fullCond);

    metrics.ai
      .counter('generate_images_stream_calls')
      .add(1, { model: model.id });

    const { content: prompt } = [...messages].pop() || {};
    if (!prompt) throw new CopilotPromptInvalid('Prompt is required');

    try {
      const modelInstance = this.#instance.image(model.id);

      const result = await generateImage({
        model: modelInstance,
        prompt,
        providerOptions: {
          openai: {
            quality: options.quality || null,
          },
        },
      });

      const imageUrls = result.images.map(
        image => `data:image/png;base64,${image.base64}`
      );

      for (const imageUrl of imageUrls) {
        yield imageUrl;
        if (options.signal?.aborted) {
          break;
        }
      }
      return;
    } catch (e: any) {
      metrics.ai.counter('generate_images_errors').add(1, { model: model.id });
      throw this.handleError(e, model.id, options);
    }
  }

  override async embedding(
    cond: ModelConditions,
    messages: string | string[],
    options: CopilotEmbeddingOptions = { dimensions: DEFAULT_DIMENSIONS }
  ): Promise<number[][]> {
    messages = Array.isArray(messages) ? messages : [messages];
    const fullCond = { ...cond, outputType: ModelOutputType.Embedding };
    await this.checkParams({ embeddings: messages, cond: fullCond, options });
    const model = this.selectModel(fullCond);

    try {
      metrics.ai
        .counter('generate_embedding_calls')
        .add(1, { model: model.id });

      const modelInstance = this.#instance.embedding(model.id, {
        dimensions: options.dimensions || DEFAULT_DIMENSIONS,
        user: options.user,
      });

      const { embeddings } = await embedMany({
        model: modelInstance,
        values: messages,
      });

      return embeddings.filter(v => v && Array.isArray(v));
    } catch (e: any) {
      metrics.ai
        .counter('generate_embedding_errors')
        .add(1, { model: model.id });
      throw this.handleError(e, model.id, options);
    }
  }

  private getOpenAIOptions(options: CopilotChatOptions, model: string) {
    const result: OpenAIResponsesProviderOptions = {};
    if (options?.reasoning && this.isReasoningModel(model)) {
      result.reasoningEffort = 'medium';
      result.reasoningSummary = 'detailed';
    }
    if (options?.user) {
      result.user = options.user;
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
    // o series reasoning models
    return model.startsWith('o');
  }
}
