import { encoding_for_model, Tiktoken, TiktokenModel } from "@dqbd/tiktoken";
import OpenAI, { ClientOptions } from 'openai';
import { v4 as uuidv4 } from "uuid";
import { Conversation, Message, Model, MODEL_TOKEN_LIMITS, Role } from "./renderer/types";

export class ApiProvider {
  private _openai: OpenAI;
  private _maxTokens: number;
  private _maxResponseTokens: number;
  private _temperature: number;
  private _topP: number;

  public apiConfig: ClientOptions;

  constructor(apiKey: string, {
    organizationId = '',
    apiBaseUrl = 'https://api.openai.com/v1',
    maxTokens = 4096,
    maxResponseTokens,
    temperature = 0.9,
    topP = 1,
  }: {
    organizationId?: string;
    apiBaseUrl?: string;
    maxTokens?: number;
    maxResponseTokens?: number;
    temperature?: number;
    topP?: number;
  } = {}) {
    // If apiBaseUrl ends with slash, remove it
    apiBaseUrl = apiBaseUrl.replace(/\/$/, '');
    // OpenAI API config
    this.apiConfig = {
      apiKey: apiKey,
      organization: organizationId,
      // baseURL: apiBaseUrl,
    };
    this._openai = new OpenAI(this.apiConfig);
    this._maxTokens = maxTokens;
    this._maxResponseTokens = maxResponseTokens ?? maxTokens;
    this._temperature = temperature;
    this._topP = topP;
  }

  // OpenAI's library doesn't support streaming, but great workaround from @danneu - https://github.com/openai/openai-node/issues/18#issuecomment-1483808526
  async* streamChatCompletion(conversation: Conversation, abortSignal: AbortSignal, {
    maxTokens = this._maxTokens,
    temperature = this._temperature,
    topP = this._topP,
    maxResponseTokens = this._maxResponseTokens,
  }: {
    maxTokens?: number;
    maxResponseTokens?: number;
    temperature?: number;
    topP?: number;
  } = {}): AsyncGenerator<any, any, unknown> {
    const model = conversation.model ?? Model.gpt_35_turbo;
    const tokensUsed = ApiProvider.countConversationTokens(conversation);

    // Max tokens cannot be greater than the model's token limit
    maxTokens = Math.min(maxTokens, MODEL_TOKEN_LIMITS[model].complete);

    // if tokensUsed > maxTokens, throw error
    if (tokensUsed > maxTokens) {
      throw new Error(`This conversation uses ${tokensUsed} tokens, but the "maxTokens" set in the extension settings is ${maxTokens}. Please increase the "maxTokens" setting or reduce the amount of code you are sending. To increase the limit, hit "More Actions" > "Settings" > search for "maxTokens".`);
    }
    const tokensLeft = Math.min(maxTokens - tokensUsed, maxResponseTokens);

    if (tokensLeft <= 0) {
      throw new Error(`This conversation uses ${tokensUsed} tokens. After applying the "maxTokens" setting of ${maxTokens}, and this model's (${model}) token limit of ${MODEL_TOKEN_LIMITS[model]}, there are no tokens left to send. Either A) Clear the conversation to reduce the conversation size or B) reduce the amount of code you are sending or C) increase the sending limit on "maxTokens" by hitting "More Actions" > "Settings" > search for "maxTokens". Note that if you are hitting the model token limit of ${MODEL_TOKEN_LIMITS[model]}, you will need to switch to a different model that accepts more tokens.`);
    }

    // Only stream if not using a proxy
    const useStream = true; // this.apiConfig.basePath === 'https://api.openai.com/v1';
    const response = await this._openai.chat.completions.create(
      {
        model,
        messages: conversation.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        max_tokens: tokensLeft,
        temperature,
        top_p: topP,
        stream: useStream,
      }
    );

    for await (const chunk of response) {
      if (abortSignal.aborted) {
        return;
      }

      try {
        const token = chunk.choices[0].delta.content;

        if (token) {
          yield token;
        }
      } catch (e: any) {
        console.error('api JSON parse error. Message:', e?.message, 'Error:', e);
      }
    }
  }

  async getChatCompletion(conversation: Conversation, {
    maxTokens = this._maxTokens,
    temperature = this._temperature,
    topP = this._topP,
    maxResponseTokens = this._maxResponseTokens,
  }: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    maxResponseTokens?: number;
  } = {}): Promise<OpenAI.Chat.Completions.ChatCompletionMessage | undefined> {
    const model = conversation.model ?? Model.gpt_35_turbo;
    const tokensUsed = ApiProvider.countConversationTokens(conversation);

    // Max tokens cannot be greater than the model's token limit
    maxTokens = Math.min(maxTokens, MODEL_TOKEN_LIMITS[model].complete);

    // if tokensUsed > maxTokens, throw error
    if (tokensUsed > maxTokens) {
      throw new Error(`Conversation uses ${tokensUsed} tokens, but the "maxTokens" set in the extension settings is ${maxTokens}. Please increase the "maxTokens" setting or reduce amount of code you're sending.`);
    }
    const tokensLeft = Math.min(maxTokens - tokensUsed, maxResponseTokens);

    if (tokensLeft <= 0) {
      throw new Error(`This conversation uses ${tokensUsed} tokens. After applying the "maxTokens" setting of ${maxTokens}, and this model's (${model}) token limit of ${MODEL_TOKEN_LIMITS[model]}, there are no tokens left to send. Either A) Clear the conversation to reduce the conversation size or B) reduce the amount of code you are sending or C) increase the sending limit on "maxTokens" by hitting "More Actions" > "Settings" > search for "maxTokens". Note that if you are hitting the model token limit of ${MODEL_TOKEN_LIMITS[model]}, you will need to switch to a different model that accepts more tokens.`);
    }

    const response = await this._openai.chat.completions.create(
      {
        model,
        messages: conversation.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        stream: false,
        max_tokens: tokensLeft,
        temperature,
        top_p: topP,
      }
    );

    return response.choices[0].message;
  }

  // Note: PromptCompletion is LEGACY
  // Using prompt as a param instead of the last message in the conversation to
  // allow for special formatting of the prompt before sending it to OpenAI
  async getPromptCompletion(prompt: string, conversation: Conversation, {
    maxTokens = this._maxTokens,
    temperature = this._temperature,
    topP = this._topP,
    maxResponseTokens = this._maxResponseTokens,
  }: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    maxResponseTokens?: number;
  } = {}): Promise<Message | undefined> {
    const model = conversation.model ?? Model.gpt_35_turbo;
    const tokensUsed = ApiProvider.countConversationTokens(conversation);

    // Max tokens cannot be greater than the model's token limit
    maxTokens = Math.min(maxTokens, MODEL_TOKEN_LIMITS[model].complete);

    // if tokensUsed > maxTokens, throw error
    if (tokensUsed > maxTokens) {
      throw new Error(`Conversation uses ${tokensUsed} tokens, but the "maxTokens" set in the extension settings is ${maxTokens}. Please increase the "maxTokens" setting or reduce amount of code you're sending.`);
    }
    const tokensLeft = Math.min(maxTokens - tokensUsed, maxResponseTokens);

    if (tokensLeft <= 0) {
      throw new Error(`This conversation uses ${tokensUsed} tokens. After applying the "maxTokens" setting of ${maxTokens}, and this model's (${model}) token limit of ${MODEL_TOKEN_LIMITS[model]}, there are no tokens left to send. Either A) Clear the conversation to reduce the conversation size or B) reduce the amount of code you are sending or C) increase the sending limit on "maxTokens" by hitting "More Actions" > "Settings" > search for "maxTokens". Note that if you are hitting the model token limit of ${MODEL_TOKEN_LIMITS[model]}, you will need to switch to a different model that accepts more tokens.`);
    }

    const response = await this._openai.chat.completions.create(
      {
        model,
        messages: [{ "role": "user", "content": prompt }],
        max_tokens: tokensLeft,
        temperature,
        top_p: topP,
        stream: false,
      }
    );

    return {
      id: uuidv4(),
      content: response.choices[0].message.content ?? '',
      rawContent: response.choices[0].message.content ?? '',
      role: Role.assistant,
      createdAt: Date.now(),
    };
  }

  // * Utility token counting methods
  // Use this.getEncodingForModel() instead of encoding_for_model() due to missing model support
  public static getEncodingForModel(model: Model): Tiktoken {
    let adjustedModel = model;

    switch (model) {
      case Model.gpt_35_turbo_16k:
        // June 27, 2023 - Tiktoken@1.0.7 does not recognize the 3.5-16k model version.
        adjustedModel = Model.gpt_35_turbo;
        break;
      case Model.gpt_4_turbo:
        // Nov 24, 2023 - Adding gpt-4-turbo, will update tiktoken at another date
        adjustedModel = Model.gpt_4;
        break;
    }

    return encoding_for_model(adjustedModel as TiktokenModel);
  }

  public static countConversationTokens(conversation: Conversation): number {
    const enc = this.getEncodingForModel(conversation.model ?? Model.gpt_35_turbo);
    let tokensUsed = 0;

    for (const message of conversation.messages) {
      tokensUsed += ApiProvider.countMessageTokens(message, conversation.model ?? Model.gpt_35_turbo, enc);
    }

    tokensUsed += 3; // every reply is primed with <im_start>assistant

    enc.free();
    return tokensUsed;
  }

  public static countMessageTokens(message: Message, model: Model, encoder?: Tiktoken): number {
    let enc = encoder ?? this.getEncodingForModel(model);
    let tokensUsed = 4; // every message follows <im_start>{role/name}\n{content}<im_end>\n

    const openAIMessage = {
      role: message.role ?? Role.user,
      content: message.content ?? '',
      // name: message.name,
    };

    for (const [key, value] of Object.entries(openAIMessage)) {
      // Assuming encoding is available and has an encode method
      const tokens = enc.encode(value);
      tokensUsed += tokens ? tokens.length : 0;

      if (key === "name") { // if there's a name, the role is omitted
        tokensUsed -= 1; // role is always required and always 1 token
      }
    }

    if (!encoder) {
      enc.free();
    }
    return tokensUsed;
  }

  // Calculate tokens remaining for OpenAI's response
  public static getRemainingPromptTokens(maxTokens: number, prompt: string, model: Model): number {
    return maxTokens - ApiProvider.countPromptTokens(prompt, model);
  }

  public static countPromptTokens(prompt: string, model: Model): number {
    const enc = this.getEncodingForModel(model);
    const tokens = enc.encode(prompt).length;

    enc.free();
    return tokens;
  }

  // * Getters and setters
  set maxTokens(value: number) {
    this._maxTokens = value;
  }

  set temperature(value: number) {
    this._temperature = value;
  }

  set topP(value: number) {
    this._topP = value;
  }

  updateApiKey(apiKey: string) {
    // OpenAI API config
    this.apiConfig = {
      apiKey: apiKey,
      organization: this.apiConfig.organization,
      // baseURL: this.apiConfig.baseURL,
    };
    this._openai = new OpenAI(this.apiConfig);
  }

  updateOrganizationId(organizationId: string) {
    // OpenAI API config
    this.apiConfig = {
      apiKey: this.apiConfig.apiKey,
      organization: organizationId,
      // baseURL: this.apiConfig.baseURL,
    };
    this._openai = new OpenAI(this.apiConfig);
  }

  updateApiBaseUrl(apiBaseUrl: string) {
    // If apiBaseUrl ends with slash, remove it
    apiBaseUrl = apiBaseUrl.replace(/\/$/, '');
    // OpenAI API config
    this.apiConfig = {
      apiKey: this.apiConfig.apiKey,
      organization: this.apiConfig.organization,
      // baseURL: this.apiConfig.baseURL,
    };
    this._openai = new OpenAI(this.apiConfig);
  }
}
