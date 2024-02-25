import * as vscode from 'vscode';
import { ApiProvider } from "./api-provider";
import { Conversation, Message, Model, Role, Verbosity, VerbosityText } from "./renderer/types";

export interface ApiRequestOptions {
	command?: string,
	conversation?: Conversation,
	questionId?: string,
	messageId?: string,
	code?: string,
	language?: string;
	topP?: number;
	temperature?: number;
	maxTokens?: number;
	verbosity?: Verbosity;
	model?: Model;
}

export default class ChatGptViewProvider implements vscode.WebviewViewProvider {
	private webView?: vscode.WebviewView;
	public subscribeToResponse: boolean;
	public model?: Model;
	public verbosity?: Verbosity;

	private api: ApiProvider = new ApiProvider();
	private _temperature: number = 0.9;
	private _topP: number = 1;
	private systemContext: string;

	private throttling: number = 100;
	private abortControllers: {
		conversationId: number,
		actionName?: string,
		controller: AbortController;
	}[] = [];
	private chatGPTModels: Model[] = [];

	public conversations: { [index: number]: Conversation; } = {
		1: {
			id: 1,
			position: 1,
			inProgress: false,
			autoscroll: true,
			messages: []
		}
	};
	public currentConversation: number = 1;

	constructor(private context: vscode.ExtensionContext) {
		this.subscribeToResponse = vscode.workspace.getConfiguration("chatgpt").get("response.showNotification") || false;
		this.model = vscode.workspace.getConfiguration("chatgpt").get("gpt3.model") as Model;
		this.verbosity = vscode.workspace.getConfiguration("chatgpt").get("verbosity") as Verbosity;
		this.systemContext = vscode.workspace.getConfiguration('chatgpt').get('systemContext') ?? vscode.workspace.getConfiguration('chatgpt').get('systemContext.default') ?? '';
		this.throttling = vscode.workspace.getConfiguration("chatgpt").get("throttling") || 100;

		// * EXPERIMENT: Turn off maxTokens
		//   Due to how extension settings work, the setting will default to the 1,024 setting
		//   from a very long time ago. New models support 128,000 tokens, but you have to tell the
		//   user to update their config to "enable" these larger contexts. With the updated UI
		//   now showing token counts, I think it's better to just turn off the maxTokens setting
		// this._maxTokens = vscode.workspace.getConfiguration("chatgpt").get("gpt3.maxTokens") as number;
		this._temperature = vscode.workspace.getConfiguration("chatgpt").get("gpt3.temperature") as number;
		this._topP = vscode.workspace.getConfiguration("chatgpt").get("gpt3.top_p") as number;

		// Initialize the API
		this.api = new ApiProvider(
			{
				apiBaseUrl: vscode.workspace.getConfiguration("chatgpt").get("gpt3.apiBaseUrl") as string,
				temperature: vscode.workspace.getConfiguration("chatgpt").get("gpt3.temperature") as number,
				topP: vscode.workspace.getConfiguration("chatgpt").get("gpt3.top_p") as number,
			});

		// Update data members when the config settings change
		vscode.workspace.onDidChangeConfiguration((e) => {
			let rebuildApiProvider = false;

			// Model
			if (e.affectsConfiguration("chatgpt.gpt3.model") || e.affectsConfiguration("chatgpt.verbosity")) {
				this.model = vscode.workspace.getConfiguration("chatgpt").get("gpt3.model") as Model;
				this.verbosity = vscode.workspace.getConfiguration("chatgpt").get("verbosity") as Verbosity;
				this.sendMessage({
					type: "updateSettings",
					model: this.model,
					verbosity: this.verbosity,
				});
			}

			// System Context
			if (e.affectsConfiguration("chatgpt.systemContext")) {
				this.systemContext = vscode.workspace.getConfiguration('chatgpt').get('systemContext') ?? vscode.workspace.getConfiguration('chatgpt').get('systemContext.default') ?? '';
			}
			// Throttling
			if (e.affectsConfiguration("chatgpt.throttling")) {
				this.throttling = vscode.workspace.getConfiguration("chatgpt").get("throttling") ?? 100;
			}
			// Api Base Url
			if (e.affectsConfiguration("chatgpt.gpt3.apiBaseUrl")) {
				rebuildApiProvider = true;
			}
			// temperature
			if (e.affectsConfiguration("chatgpt.gpt3.temperature")) {
				this._temperature = vscode.workspace.getConfiguration("chatgpt").get("gpt3.temperature") as number ?? 0.9;
				rebuildApiProvider = true;
			}
			// topP
			if (e.affectsConfiguration("chatgpt.gpt3.top_p")) {
				this._topP = vscode.workspace.getConfiguration("chatgpt").get("gpt3.top_p") as number ?? 1;
				rebuildApiProvider = true;
			}

			if (rebuildApiProvider) {
				this.api = new ApiProvider(
					{
						apiBaseUrl: vscode.workspace.getConfiguration("chatgpt").get("gpt3.apiBaseUrl") as string,
						temperature: vscode.workspace.getConfiguration("chatgpt").get("gpt3.temperature") as number,
						topP: vscode.workspace.getConfiguration("chatgpt").get("gpt3.top_p") as number,
					});
			}
		});
		/*
		// if any of the extension settings change, send a message to the webview for the "settingsUpdate" event
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("chatgpt")) {
				this.sendMessage({
					type: "settingsUpdate",
					value: vscode.workspace.getConfiguration("chatgpt")
				});
			}
		});

		// Load translations
		loadTranslations(context.extensionPath).then((translations) => {
			// Serialize and send translations to the webview
			const serializedTranslations = JSON.stringify(translations);

			this.sendMessage({ type: 'setTranslations', value: serializedTranslations });
		}).catch((err) => {
			console.error("Failed to load translations", err);
		});
				*/;
	}

	/*
		// Param is optional - if provided, it will change the API key to the provided value
		// This func validates the API key against the OpenAI API (and notifies the webview of the result)
		// If valid it updates the chatGPTModels array (and notifies the webview of the available models)
		public async updateApiKeyState(apiKey: string = '') {
			let { valid, models } = await this.isGoodApiKey(apiKey);
	
			if (valid) {
				// Get an updated list of models
				this.getChatGPTModels(models).then(async (models) => {
					this.chatGPTModels = models;
	
					this.sendMessage({
						type: "chatGPTModels",
						value: this.chatGPTModels
					});
				});
			}
		}
	
		private async rebuildApiProvider() {
			this.api = new ApiProvider(
				{
					apiBaseUrl: vscode.workspace.getConfiguration("chatgpt").get("gpt3.apiBaseUrl") as string,
					temperature: vscode.workspace.getConfiguration("chatgpt").get("gpt3.temperature") as number,
					topP: vscode.workspace.getConfiguration("chatgpt").get("gpt3.top_p") as number,
				});
		}
	
		public updateApiUrl(apiUrl: string = '') {
			if (!apiUrl) {
				console.error("updateApiUrl called with no apiUrl");
				return;
			}
	
			if (apiUrl.endsWith("/")) {
				// Remove trailing slash
				apiUrl = apiUrl.slice(0, -1);
			}
	
			// if api url ends with /chat or /chat/completions, remove it
			if (apiUrl.endsWith("/chat")) {
				apiUrl = apiUrl.slice(0, -5);
			} else if (apiUrl.endsWith("/chat/completions")) {
				apiUrl = apiUrl.slice(0, -17);
			}
	
			vscode.workspace.getConfiguration("chatgpt").update("gpt3.apiBaseUrl", apiUrl, true);
		}
	*/

	public refreshChat() {
		const conversation = this.conversations[this.currentConversation] as Conversation;
		this.sendMessage({
			type: "updateSettings",
			model: this.model,
			verbosity: this.verbosity,
		});
		this.sendMessage({
			type: "showConversation",
			conversationId: this.currentConversation,
		});
		this.sendMessage({
			type: "showInProgress",
			conversationId: this.currentConversation,
			inProgress: conversation.inProgress,
		});
		this.sendMessage({
			type: "truncate",
			conversationId: this.currentConversation,
			nr: 0,
		});
		for (let i = 1; i < conversation.messages.length; i++) {
			const msg = conversation.messages[i];
			this.sendMessage({
				type: "addChatMessage",
				conversationId: this.currentConversation,
				nr: i,
				role: msg.role,
				content: msg.rawContent,
				verbosity: msg.verbosity,
				model: msg.model,
			});
		}
	}

	public setChat(chat_id: any) {
		const conversation = this.conversations[1 * chat_id] as Conversation;
		const pos = conversation.position;
		if (this.webView) {
			this.webView.title = pos > 9 ? "ad hoc" : "#" + pos;
		}
		if (this.currentConversation !== 1 * chat_id) {
			this.currentConversation = 1 * chat_id;
			this.refreshChat();
		}
	}

	public showChat(position: any) {
		position = 1 * position;
		for (const conversation of Object.values(this.conversations)) {
			if (conversation.position == position) {
				this.setChat(conversation.id);
				break;
			}
		}
	}

	private slots: string = "1";
	public updateContext() {
		let text = "";
		for (const conversation of Object.values(this.conversations)) {
			if (conversation.position <= 9) {
				text += conversation.position;
			}
		}
		this.slots = text;
		vscode.commands.executeCommand('setContext', 'chatGPT.chat_ids', text);
	}

	public findEmptySlot() {
		for (let i = 1; i <= 9; i++) {
			if (this.slots.indexOf("" + i) < 0)
				return i;
		}
		return 10;
	}
	public findNextSlot(i: number) {
		for (; i <= 9; i++) {
			if (this.slots.indexOf("" + i) >= 0)
				return i;
		}
		for (i = 1; i <= 9; i++) {
			if (this.slots.indexOf("" + i) >= 0)
				return i;
		}
		return 10;
	}

	public newChat2(i: number, position: number) {
		this.conversations[i] = {
			id: i,
			position: position,
			inProgress: false,
			autoscroll: true,
			messages: []
		};
		this.updateContext();
		this.setChat(i);
		return this.conversations[i];
	}

	public newChat(position: number | undefined = undefined) {
		if (position === undefined) {
			position = this.findEmptySlot();
		}
		const toBeRemoved = [];
		let maxId = 10;
		for (const conversation of Object.values(this.conversations)) {
			if (conversation.position >= 10 && !conversation.inProgress) {
				toBeRemoved.push(conversation.id);
				this.sendMessage({
					type: "closeConversation",
					conversationId: conversation.id,
				});
			} else {
				if (maxId < conversation.id) {
					maxId = conversation.id;
				}
			}
		}
		for (const i of toBeRemoved) {
			delete this.conversations[i];
		}
		return this.newChat2(maxId + 1, position);
	}

	public closeChat() {
		const position = this.conversations[this.currentConversation].position;
		delete this.conversations[this.currentConversation];
		this.sendMessage({
			type: "closeConversation",
			conversationId: this.currentConversation,
		});
		const i = this.findNextSlot(position + 1);
		if (i == 10 || i == position) {
			this.newChat();
		} else {
			this.updateContext();
			this.showChat(i);
		}
	}

	public clearChat() {
		const position = this.conversations[this.currentConversation].position;
		delete this.conversations[this.currentConversation];
		this.newChat(position);
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this.webView = webviewView;

		webviewView.webview.options = {
			// Allow scripts in the webview
			enableScripts: true,

			localResourceRoots: [
				this.context.extensionUri
			]
		};

		webviewView.webview.html = this.getWebviewHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(async data => {
			console.log(data);
			switch (data.type) {
				case 'refreshChat':
					this.refreshChat();
					break;
				case 'sendMessage': {
					const conversation = this.conversations[data.conversation_id] as Conversation;
					if (conversation.position >= 10) {
						// convert ad hoc chat to normal chat
						const pos = this.findEmptySlot();
						conversation.position = pos;
						this.updateContext();
						this.setChat(conversation.id);
					}
					if (data.chat_id != 'new') {
						conversation.messages.splice(data.chat_id + 1);
						this.sendMessage({
							type: "truncate",
							conversationId: data.conversation_id,
							nr: data.chat_id,
						});
					}
					let options: ApiRequestOptions = {
						model: data.model,
						verbosity: data.verbosity,
					};
					if (data?.includeEditorSelection) {
						const selection = this.getActiveEditorSelection();
						options.code = selection?.content ?? "";
						options.language = selection?.language ?? "";
					}
					await this.sendApiRequest(conversation, data.message, options);
					break;
				}
				case 'editCode':
					let doc = vscode.window.activeTextEditor?.document;
					let text = doc?.getText();
					let left_uri = vscode.Uri.parse('chatgpt-diff:previous').with({ fragment: text });

					const escapedString = (data.value as string).replace(/\$/g, '\\$');;
					vscode.window.activeTextEditor?.insertSnippet(new vscode.SnippetString(escapedString));
					let right_uri = vscode.window.activeTextEditor?.document.uri;

					let success = await vscode.commands.executeCommand('vscode.diff', left_uri, right_uri);
					//this.logEvent("code-inserted");
					break;
				case 'openNew':
					const document = await vscode.workspace.openTextDocument({
						content: data.value,
						language: data.language
					});
					vscode.window.showTextDocument(document);

					//this.logEvent(data.language === "markdown" ? "code-exported" : "code-opened");
					break;

				/*
				
				
								case 'addFreeTextQuestion':
									const apiRequestOptions = {
										command: "freeText",
										conversation: data.conversation ?? null,
										questionId: data.questionId ?? null,
										messageId: data.messageId ?? null,
									} as ApiRequestOptions;
				
									// if includeEditorSelection is true, add the code snippet to the question
									if (data?.includeEditorSelection) {
										const selection = this.getActiveEditorSelection();
										apiRequestOptions.code = selection?.content ?? "";
										apiRequestOptions.language = selection?.language ?? "";
									}
				
									this.sendApiRequest(data.value, apiRequestOptions);
									break;*/
				/*
			case 'setModel':
				this.model = data.value;
				await vscode.workspace.getConfiguration("chatgpt").update("gpt3.model", data.value, vscode.ConfigurationTarget.Global);
				this.logEvent("model-changed to " + data.value);
				break;*/
				/*		case 'cleargpt3':
							// this.apiGpt3 = undefined;
		
							this.logEvent("gpt3-cleared");
							break;
						case 'openSettings':
							vscode.commands.executeCommand('workbench.action.openSettings', "@ext:chris-hayes.chatgpt-reborn chatgpt.");
		
							this.logEvent("settings-opened");
							break;
						case 'openSettingsPrompt':
							vscode.commands.executeCommand('workbench.action.openSettings', "@ext:chris-hayes.chatgpt-reborn promptPrefix");
		
							this.logEvent("settings-prompt-opened");
							break;
						case "stopGenerating":
							if (data?.conversationId) {
								this.stopGenerating(data.conversationId);
							} else {
								console.warn("Main Process - No conversationId provided to stop generating");
							}
							break;
						case "getSettings":
							this.sendMessage({
								type: "settingsUpdate",
								value: vscode.workspace.getConfiguration("chatgpt")
							});
							break;
						case "exportToMarkdown":
							// convert all messages in the conversation to markdown and open a new document with the markdown
							if (data?.conversation) {
								const markdown = this.convertMessagesToMarkdown(data.conversation);
		
								const markdownExport = await vscode.workspace.openTextDocument({
									content: markdown,
									language: 'markdown'
								});
		
								vscode.window.showTextDocument(markdownExport);
							} else {
								console.error("Main Process - No conversation to export to markdown");
							}
							break;
						case "getChatGPTModels":
							this.sendMessage({
								type: "chatGPTModels",
								value: this.chatGPTModels
							});
							break;
						case "changeApiUrl":
							this.updateApiUrl(data.value);
							break;
						case "setVerbosity":
							const verbosity = data?.value ?? Verbosity.normal;
							vscode.workspace.getConfiguration("chatgpt").update("verbosity", verbosity, vscode.ConfigurationTarget.Global);
							break;
						case "setCurrentConversation":
							this.currentConversation = data.conversation;
							break;
						case 'getTokenCount':
							const convTokens = ApiProvider.countConversationTokens(data.conversation);
							let userInputTokens = ApiProvider.countMessageTokens({
								role: Role.user,
								content: data.conversation.userInput
							} as Message, data.conversation?.model ?? this.model ?? Model.gpt_35_turbo);
		
							// If "use editor selection" is enabled, add the tokens from the editor selection
							if (data?.useEditorSelection) {
								const selection = this.getActiveEditorSelection();
								// Roughly approximate the number of tokens used for the instructions about using the editor selection
								const roughApproxCodeSelectionContext = 40;
		
								userInputTokens += ApiProvider.countMessageTokens({
									role: Role.user,
									content: selection?.content ?? ""
								} as Message, data.conversation?.model ?? this.model ?? Model.gpt_35_turbo) + roughApproxCodeSelectionContext;
							}
		
							this.sendMessage({
								type: "tokenCount",
								tokenCount: {
									messages: convTokens,
									userInput: userInputTokens,
									minTotal: convTokens + userInputTokens,
								},
							});
							break;
						case 'runAction':
							const actionId: ActionNames = data.actionId as ActionNames;
		
							const controller = new AbortController();
							this.abortControllers.push({
								actionName: data.actionId,
								controller
							});
		
							try {
								await ActionRunner.runAction(actionId, this.api, this.systemContext, controller);
								this.sendMessage({
									type: "actionComplete",
									actionId,
								});
							} catch (error: any) {
								console.error("Main Process - Error running action: " + actionId);
								console.error(error);
		
								this.sendMessage({
									type: "actionError",
									actionId,
									error: error?.message ?? "Unknown error"
								});
							}
		
							break;
						case "stopAction":
							if (data?.actionId) {
								this.stopAction(data.actionId);
							} else {
								console.warn("Main Process - No actionName provided to stop action");
							}
							break;
						default:
							console.warn('Main Process - Uncaught message type: "' + data.type + '"');
							break;
							*/
			}
		});
		/*
				if (this.leftOverMessage !== null) {
					// If there were any messages that wasn't delivered, render after resolveWebView is called.
					this.sendMessage(this.leftOverMessage);
					this.leftOverMessage = null;
				}*/
	}
	/*
	private convertMessagesToMarkdown(conversation: Conversation): string {
		let markdown = conversation.messages.reduce((accumulator: string, message: Message) => {
			let role = 'Unknown';
			if (message.role === Role.user) {
				role = 'You';
			} else if (message.role === Role.system) {
				role = 'System Context';
			} else if (message.role === Role.assistant) {
				role = 'ChatGPT';
			}
			const isError = message.isError ? "ERROR: " : "";
			const content = message.rawContent ?? message.content;
	
			let formattedMessage = `<code>**${isError}[${role}]**</code>\n${content}\n\n`;
	
			// User included editor code selection in their question?
			if (message.role === Role.user && message.questionCode) {
				let code = message.questionCode;
	
				try {
					// The code will be already formatted with highlight.js
					code = code.replace('<pre><code class="language-', '');
					const split = code.split('">');
					let language = split[0];
					code = split[1].replace('</code></pre>', '');
	
					formattedMessage += `\`\`\`${language}\n${code}\n\`\`\`\n\n`;
				} catch (error) {
					// Fallback
					formattedMessage += `\`\`\`\n${code}\n\`\`\`\n\n`;
				}
			}
	
			return accumulator + formattedMessage;
		}, "");
	
		return markdown;
	}
	
	private stopGenerating(conversationId: string): void {
		// Send the abort signal to the corresponding controller
		this.abortControllers.find((controller) => controller.conversationId === conversationId)?.controller.abort();
		// Remove abort controller from array
		this.abortControllers = this.abortControllers.filter((controller) => controller.conversationId !== conversationId);
	
		// show inProgress status update
		this.sendMessage({
			type: 'showInProgress',
			inProgress: false,
			conversationId,
		});
	}
	
	private stopAction(actionName: string): void {
		// Send the abort signal to the corresponding controller
		this.abortControllers.find((controller) => controller.actionName === actionName)?.controller.abort();
		// Remove abort controller from array
		this.abortControllers = this.abortControllers.filter((controller) => controller.actionName !== actionName);
	}*/

	private get isCodexModel(): boolean {
		return !!this.model?.startsWith("code-");
	}
	/*
	async isGoodApiKey(apiKey: string = ''): Promise<{
		valid: boolean,
		models: any[],
	}> {
		return {
			valid: true,
			models: ["gpt-4-32k", "babbage-002"]
		};
	}
	
	async getModels(): Promise<any[]> {
		return (await this.isGoodApiKey()).models;
	}
	
	async getChatGPTModels(fullModelList: any[] = []): Promise<Model[]> {
		if (fullModelList?.length && fullModelList?.length > 0) {
			return fullModelList.filter((model: any) => CHATGPT_MODELS.includes(model.id)).map((model: any) => {
				return model.id as Model;
			});
		} else {
			const models = await this.getModels();
	
			return models.filter((model: any) => CHATGPT_MODELS.includes(model.id)).map((model: any) => {
				return model.id as Model;
			});
		}
	}*/

	private processQuestion(question: string, conversation: Conversation, verbosity: Verbosity, code?: string, language?: string): string {
		const verbosityText = VerbosityText[verbosity];
		question += `\n${verbosityText}`;

		if (code !== null && code !== undefined) {
			// If the lanague is not specified, get it from the active editor's language
			if (!language) {
				language = vscode.window.activeTextEditor?.document.languageId;
			}
			if (language) {
				question += `\nThe following code is in ${language} programming language.`;
			}
			question += `\nCode in question:\n\`\`\`${language}\n${code}\n\`\`\``;
		}
		return question;
	}

	/*
	formatMessageContent(rawContent: string, markdown: boolean): string {
		return marked.parse(
			!markdown
				? "```\r\n" + unEscapeHTML(rawContent) + " \r\n ```"
				: (rawContent ?? "").split("```").length % 2 === 1
					? rawContent
					: rawContent + "\n\n```\n\n"
		);
	}*/


	public async sendApiRequest(conversation: Conversation, prompt: string, options: ApiRequestOptions) {
		// this.logEvent("api-request-sent", { "chatgpt.command": options.command, "chatgpt.hasCode": String(!!options.code) });
		const responseInMarkdown = !this.isCodexModel;

		// If the ChatGPT view is not in focus/visible; focus on it to render Q&A
		if (this.webView === null) {
			vscode.commands.executeCommand('vscode-chatgpt.view.focus');
		} else {
			this.webView?.show?.(true);
		}
		this.setChat(conversation.id);

		conversation.inProgress = true;

		// 1. First add the system message
		if (conversation.messages.length === 0) {
			conversation.messages.push({
				content: this.systemContext,
				rawContent: this.systemContext,
				role: Role.system,
			});
		}

		// 2. Add the user's question to the conversation
		const formattedPrompt = this.processQuestion(prompt, conversation, options.verbosity || Verbosity.normal, options.code, options.language);
		console.log(formattedPrompt);
		console.log(prompt);
		const msg = {
			content: formattedPrompt,
			rawContent: prompt + (options.code ? `\n\`\`\`${options.language}\n${options.code}\n\`\`\`` : ''),
			role: Role.user,
			verbosity: options.verbosity,
			model: options.model,
		};
		conversation.messages.push(msg);

		// 3. Tell the webview about the new messages
		this.sendMessage({
			type: "addChatMessage",
			nr: conversation.messages.length - 1,
			role: Role.user,
			content: msg.rawContent,
			conversationId: conversation.id,
			verbosity: msg.verbosity,
			model: msg.model,
		});

		// Tell the webview that this conversation is in progress
		this.sendMessage({
			type: 'showInProgress',
			inProgress: true,
			conversationId: conversation.id,
		});

		try {
			const message: Message = {
				// Normally random ID is generated, but when editing a question, the response update the same message
				content: '',
				rawContent: '',
				role: Role.assistant,
			};
			conversation.messages.push(message);

			// Initialize message in webview. Now event streaming only needs to update the message content
			this.sendMessage({
				type: "addChatMessage",
				nr: conversation.messages.length - 1,
				role: Role.assistant,
				content: "",
				conversationId: conversation.id,
			});

			let lastMessageTime = 0;
			const controller = new AbortController();
			this.abortControllers.push({ conversationId: conversation.id, controller });

			// Stream ChatGPT response (this is using an async iterator)
			for await (const token of this.api.streamChatCompletion(conversation, controller.signal, options.model || this.model || Model.gpt_35_turbo_16k, {
				temperature: this._temperature,
				topP: this._topP,
			})) {
				message.rawContent += token;

				const now = Date.now();
				// Throttle the number of messages sent to the webview
				if (now - lastMessageTime > this.throttling) {
					message.content = message.rawContent; //this.formatMessageContent((message.rawContent ?? ''), responseInMarkdown);

					// Send webview updated message content
					this.sendMessage({
						type: "addChatMessage",
						nr: conversation.messages.length - 1,
						role: Role.assistant,
						content: message.content,
						conversationId: conversation.id,
					});


					lastMessageTime = now;
				}
			}

			// remove the abort controller
			this.abortControllers = this.abortControllers.filter((controller) => controller.conversationId !== conversation.id);

			message.done = true;
			message.content = message.rawContent; //this.formatMessageContent(message.rawContent ?? "", responseInMarkdown);

			// Send webview full updated message
			this.sendMessage({
				type: "addChatMessage",
				nr: conversation.messages.length - 1,
				role: Role.assistant,
				content: message.content,
				conversationId: conversation.id,
			});


			const hasContinuation = ((message.content.split("```").length) % 2) === 0;

			if (hasContinuation) {
				message.content = message.content + " \r\n ```\r\n";
				vscode.window.showInformationMessage("It looks like ChatGPT didn't complete their answer for your coding question. You can ask it to continue and combine the answers.", "Continue and combine answers")
					.then(async (choice) => {
						if (choice === "Continue and combine answers") {
							this.sendApiRequest(conversation, "Continue", {});
						}
					});
			}

			if (this.subscribeToResponse) {
				vscode.window.showInformationMessage("ChatGPT responded to your question.", "Open conversation").then(async () => {
					await vscode.commands.executeCommand('vscode-chatgpt.view.focus');
				});
			}
			return hasContinuation ? undefined : message.rawContent;
		} catch (error: any) {
			let message;
			let apiMessage = error?.response?.data?.error?.message || error?.tostring?.() || error?.message || error?.name;

			console.error("api-request-failed info:", JSON.stringify(error, null, 2));
			console.error("api-request-failed error obj:", error);

			// For whatever reason error.status is undefined, but the below works
			const status = JSON.parse(JSON.stringify(error)).status ?? error?.status ?? error?.response?.status ?? error?.response?.data?.error?.status;

			switch (status) {
				case 400:
					message = `400 Bad Request\n\nYour model: '${this.model}' may be incompatible or one of your parameters is unknown. Reset your settings to default.`;
					break;
				case 401:
					message = '401 Unauthorized\n\nMake sure your API key is correct, you can reset it by going to "More Actions" > "Reset API Key". Potential reasons: \n- 1. Incorrect API key provided.\n- 2. Incorrect Organization provided. \n See https://platform.openai.com/docs/guides/error-codes for more details.';
					break;
				case 403:
					message = '403 Forbidden\n\nYour token has expired. Please try authenticating again.';
					break;
				case 404:
					message = `404 Not Found\n\n`;

					// For certain certain proxy paths, recommand a fix
					message += `If you've changed the API baseUrlPath, double-check that it is correct.\nYour model: '${this.model}' may be incompatible or you may have exhausted your ChatGPT subscription allowance.`;
					break;
				case 429:
					message = "429 Too Many Requests\n\nToo many requests try again later. Potential reasons: \n 1. You exceeded your current quota, please check your plan and billing details\n 2. You are sending requests too quickly \n 3. The engine is currently overloaded, please try again later. \n See https://platform.openai.com/docs/guides/error-codes for more details.";
					break;
				case 500:
					message = "500 Internal Server Error\n\nThe server had an error while processing your request, please try again.\nSee https://platform.openai.com/docs/guides/error-codes for more details.";
					break;
				default:
					if (apiMessage) {
						message = `${status ? status + '\n\n' : ''}${apiMessage}`;
					} else {
						message = `${status}\n\nAn unknown error occurred. Please check your internet connection, clear the conversation, and try again.\n\n${apiMessage}`;
					}
			}

			this.sendMessage({
				type: 'addError',
				conversationId: conversation.id,
				value: message,
			});

			return;
		} finally {
			this.sendMessage({
				type: 'showInProgress',
				conversationId: conversation.id,
				inProgress: false,
			});
			conversation.inProgress = false;
		}
	}

	/**
	 * Message sender, stores if a message cannot be delivered
	 * @param message Message to be sent to WebView
	 * @param ignoreMessageIfNullWebView We will ignore the command if webView is null / not - focused
	*/
	public sendMessage(message: any) {
		if (this.webView) {
			this.webView?.webview.postMessage(message);
		}
	}

	/*
		private logEvent(eventName: string, properties ?: {}): void {
console.debug(eventName, {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	"chatgpt.model": this.model || "unknown", ...properties
}, {
	"chatgpt.properties": properties,
});
}
	
		private logError(eventName: string): void {
console.error(eventName, {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	"chatgpt.model": this.model || "unknown"
});
}
	*/
	private getWebviewHtml(webview: vscode.Webview): string {
		const vendorMainCss = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'));
		const vendorHighlightCss = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'vendor', 'highlight.min.css'));
		const vendorHighlightJs = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'vendor', 'highlight.min.js'));
		const vendorMarkedJs = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'vendor', 'marked.min.js'));
		// React code bundled by webpack, this includes styling
		const webpackScript = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview.bundle.js'));

		const nonce = this.getRandomId();

		return `<!DOCTYPE html>
					<html lang="en">
					<head>
						<meta charset="UTF-8">
						<meta name="viewport" content="width=device-width, initial-scale=1.0">
					</head>
					<body class="overflow-hidden">
						<div id="root" class="flex flex-col h-screen"></div>
						<script nonce="${nonce}" src="${webpackScript}"></script>
						<script src="${vendorHighlightJs}" defer async></script>
						<script src="${vendorMarkedJs}" defer async></script>
						<link href="${vendorHighlightCss}" rel="stylesheet">
						<link href="${vendorMainCss}" rel="stylesheet">
					</body>
					</html>`;
	}

	private getRandomId() {
		let text = '';
		const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		for (let i = 0; i < 32; i++) {
			text += possible.charAt(Math.floor(Math.random() * possible.length));
		}
		return text;
	}


	private getActiveEditorSelection(): {
		content: string;
		language: string;
	}
		| undefined {
		const editor = vscode.window.activeTextEditor;

		if (!editor) {
			return;
		}

		const selection = editor.document.getText(editor.selection);
		const language = editor.document.languageId;

		return {
			content: selection,
			language
		};
	}
};
