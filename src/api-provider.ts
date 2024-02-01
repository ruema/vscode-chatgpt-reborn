import { encoding_for_model, Tiktoken, TiktokenModel } from "@dqbd/tiktoken";
import { Conversation, Message, Model, MODEL_TOKEN_LIMITS, Role } from "./renderer/types";

export class ApiProvider {
  private _apiBaseUrl: string;
  private _temperature: number;
  private _topP: number;

  constructor({
    apiBaseUrl = '',
    maxTokens = 4096,
    maxResponseTokens,
    temperature = 0.9,
    topP = 1,
  }: {
    apiBaseUrl?: string;
    maxTokens?: number;
    maxResponseTokens?: number;
    temperature?: number;
    topP?: number;
  } = {}) {
    // If apiBaseUrl ends with slash, remove it
    this._apiBaseUrl = apiBaseUrl.replace(/\/$/, '');
    this._temperature = temperature;
    this._topP = topP;
  }

  getRemainingTokens(model: Model, promptTokensUsed: number) {
    const modelContext = MODEL_TOKEN_LIMITS[model].context;
    const modelMax = MODEL_TOKEN_LIMITS[model].max;

    // OpenAI's maxTokens is used as max (prompt + complete) tokens
    // We must calculate total context window - prompt tokens being sent to determine max response size
    // This is complicated by the fact that some models have a max token completion limit
    let tokensLeft = 4096;

    if (modelMax !== undefined) {
      // Models with a max token limit (ie gpt-4-turbo)
      tokensLeft = Math.min(modelContext - promptTokensUsed, modelMax);
    } else {
      // Models without a max token limit (ie gpt-4)
      tokensLeft = modelContext - promptTokensUsed;
    }

    if (tokensLeft < 0) {
      throw new Error(`This conversation uses ${promptTokensUsed} tokens, but this model (${model}) only supports ${modelContext} context tokens. Please reduce the amount of code you're including, clear the conversation to reduce past messages size or use a different model with a bigger prompt token limit.`);
    }

    return tokensLeft;
  }

  // OpenAI's library doesn't support streaming, but great workaround from @danneu - https://github.com/openai/openai-node/issues/18#issuecomment-1483808526
  async* streamChatCompletion(conversation: Conversation, abortSignal: AbortSignal, {
    temperature = this._temperature,
    topP = this._topP,
  }: {
    temperature?: number;
    topP?: number;
  } = {}): AsyncGenerator<any, any, unknown> {
    conversation.messages[0].role;

    const input = {
      stream: true,
      messages: conversation.messages.map(m => ({
        role: m.role,
        content: m.content
      }))
    };

    const API_TOKEN = "xxx";
    const response = await fetch(
      this._apiBaseUrl,
      {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
        method: "POST",
        body: JSON.stringify(input),
      }
    );
    if (response.headers.get('Content-Type') == 'application/json') {
      const result = await response.json();
      if (result.success) {
        yield result.result.response;
      } else {
        throw new Error(result.errors.map((e: any) => e.message).join('\n'));
      }
    } else {
      const textDecoderStream = new TextDecoderStream();
      const stream = response?.body?.pipeThrough(textDecoderStream);
      if (!stream) return;
      let data = "";
      for await (const chunk of (stream as any)) {
        // Do something with each chunk
        data += chunk;
        let lines = data.split('\n');
        data = lines.pop() as string;
        for (const line of lines) {
          const m = line.match(/^data:\s*(.*?)\s*$/);
          if (m) {
            if (m[1] == '[DONE]') break;
            yield JSON.parse(m[1]).response;
          }
        }
      }
    }
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
  set temperature(value: number) {
    this._temperature = value;
  }

  set topP(value: number) {
    this._topP = value;
  }

  updateApiBaseUrl(apiBaseUrl: string) {
    // If apiBaseUrl ends with slash, remove it
    this._apiBaseUrl = apiBaseUrl.replace(/\/$/, '');
  }
}
