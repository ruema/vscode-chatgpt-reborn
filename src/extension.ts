import * as vscode from "vscode";
import ChatGptViewProvider, { ApiRequestOptions } from './chatgpt-view-provider';
import { Conversation, Verbosity } from "./renderer/types";

const menuCommands = ["generateCode", "adhoc"];

class ChatRequest {
	editor: vscode.TextEditor;
	document: vscode.TextDocument;
	start: number;
	end: number;
	constructor(editor: vscode.TextEditor, selection: vscode.Selection) {
		this.editor = editor;
		this.document = editor.document;
		this.start = this.document.offsetAt(selection.start);
		this.end = this.document.offsetAt(selection.end);
	}
	public edit(new_code: string) {
		this.editor.edit(async editBuilder => {
			const text = this.document?.getText();
			const left_uri = vscode.Uri.parse('chatgpt-diff:previous').with({ fragment: text });
			const right_uri = this.document.uri;
			const range = new vscode.Range(this.document.positionAt(this.start), this.document.positionAt(this.end));
			editBuilder.replace(range, new_code);
			const success = await vscode.commands.executeCommand('vscode.diff', left_uri, right_uri);
		});
	}
}


export class ConverterCodeActionProvider implements vscode.CodeActionProvider {
	public provideCodeActions(): vscode.CodeAction[] {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return [];
		const selection = editor.selection;
		const code = editor.document.getText(selection);

		// If the selected text is empty, don't show the code action in quick fix menu
		if (!code) return [];

		const prompts = vscode.workspace.getConfiguration("chatgpt").get("gpt3.prompts");
		if (!prompts) return [];

		// show the code action in quick fix menu
		return (prompts as any[])
			.map(c => c.match(/^(?:\s*\[(.*?)\])?\s*(.*?)\s*:\s*(.*)\s*$/))
			.filter(groups => !groups[1] || groups[1] == 'inline' || groups[1].split(',').includes(editor.document.languageId))
			.map(groups => {
				const inline = groups[1] && groups[1].split(',').includes('inline');
				let action = new vscode.CodeAction(
					"GPT: " + groups[2],
					inline ? vscode.CodeActionKind.RefactorInline : vscode.CodeActionKind.Refactor
				);
				action.command = inline ? {
					command: "vscode-chatgpt.inlinecommand",
					title: "GPT: " + groups[2],
					arguments: [groups[3], code, selection, editor],
				} : {
					command: "vscode-chatgpt.command",
					title: "GPT: " + groups[2],
					arguments: [groups[3], code, selection, editor],
				};
				return action;
			});
	}
}

export async function activate(context: vscode.ExtensionContext) {
	const myProvider = new class implements vscode.TextDocumentContentProvider {

		// emitter and its event
		onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
		onDidChange = this.onDidChangeEmitter.event;

		provideTextDocumentContent(uri: vscode.Uri): string {
			return uri.fragment;
		}
	};
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("chatgpt-diff", myProvider));

	let adhocCommandPrefix: string = context.globalState.get("chatgpt-adhoc-prompt") || '';
	const provider = new ChatGptViewProvider(context);

	const view = vscode.window.registerWebviewViewProvider(
		"vscode-chatgpt.view",
		provider/*,
		{
			webviewOptions: {
				retainContextWhenHidden: true,
			},
		}*/
	);

	const actionProvider = vscode.languages.registerCodeActionsProvider(
		{ language: "*", scheme: "*" },
		new ConverterCodeActionProvider()
	);

	const actionCommand = vscode.commands.registerCommand('vscode-chatgpt.command', async (prompt, code, selection, editor) => {
		if (code && prompt) {
			const options: ApiRequestOptions = {
				code: code,
				language: editor.document.languageId,
			};
			provider?.newChat2(0);
			const conversation = provider?.conversations[0];
			await provider?.sendApiRequest(conversation, prompt, options);
		} else {
			console.error('command - No current conversation found');
		}
	});


	let chat_requests: ChatRequest[] = [];
	const actionInlineCommand = vscode.commands.registerCommand('vscode-chatgpt.inlinecommand', async (prompt, code, selection, editor: vscode.TextEditor) => {
		if (code && prompt) {
			const title = 'inline';
			const currentConversation = {
				id: `${title}-${Date.now()}`,
				title,
				messages: [],
				inProgress: false,
				createdAt: Date.now(),
				model: provider?.currentConversation?.model,
				autoscroll: true,
				verbosity: Verbosity.code
			} as Conversation;

			if (currentConversation) {
				const request = new ChatRequest(editor, selection);
				chat_requests.push(request);
				const document = editor.document;
				const msg = await provider?.sendApiRequest(prompt, {
					command: 'command',
					code: code,
					language: document.languageId,
					conversation: currentConversation,
				});
				// find the code to include
				const match = msg?.match(/```.*?\n(.*?)\n```/s);
				chat_requests.splice(chat_requests.indexOf(request));
				if (match) {
					request.edit(match[1]);
				}
			} else {
				console.error('command - No current conversation found');
			}
		}
	});

	vscode.workspace.onDidChangeTextDocument(event => {
		for (const request of chat_requests) {
			if (request.document === event.document) {
				for (const change of event.contentChanges) {
					const delta = change.text.length - change.rangeLength;
					const p1 = change.rangeOffset;
					const p2 = p1 + change.rangeLength;
					if (p2 <= request.start) {
						request.start += delta;
						request.end += delta;
					} else if (p1 <= request.start) {
						if (p2 >= request.end) {
							request.start = request.end = p1;
						} else {
							request.start = p1;
							request.end += delta;
						}
					} else if (p1 <= request.end) {
						if (p2 <= request.end) {
							request.end += delta;
						} else {
							request.end = p1;
						}
					}
				}
			}
		}
	}, null, context.subscriptions);



	const freeText = vscode.commands.registerCommand("vscode-chatgpt.freeText", async () => {
		const value = await vscode.window.showInputBox({
			prompt: "Ask anything...",
		});

		if (value) {
			const currentConversation = provider.currentConversation;

			if (currentConversation) {
				provider?.sendApiRequest(value, {
					command: "freeText",
					conversation: currentConversation,
					language: vscode.window.activeTextEditor?.document.languageId,
				});
			} else {
				console.error("freeText - No current conversation found");
			}
		}
	});

	const resetThread = vscode.commands.registerCommand("vscode-chatgpt.clearConversation", async () => {
		provider?.clearChat();
	});
	const newChat = vscode.commands.registerCommand("vscode-chatgpt.newChat", async () => {
		provider?.newChat();
	});
	const closeChat = vscode.commands.registerCommand("vscode-chatgpt.closeChat", async () => {
		provider?.closeChat();
	});

	const exportConversation = vscode.commands.registerCommand("vscode-chatgpt.exportConversation", async () => {
		const currentConversation = provider.currentConversation;
		provider?.sendMessage({ type: 'exportToMarkdown', conversation: currentConversation }, true);
	});

	const clearSession = vscode.commands.registerCommand("vscode-chatgpt.clearSession", () => {
		// context.globalState.update("chatgpt-gpt3-apiKey", null);
	});

	const configChanged = vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('chatgpt.response.showNotification')) {
			provider.subscribeToResponse = vscode.workspace.getConfiguration("chatgpt").get("response.showNotification") || false;
		}

		if (e.affectsConfiguration('chatgpt.gpt3.model')) {
			provider.model = vscode.workspace.getConfiguration("chatgpt").get("gpt3.model");
		}

		if (e.affectsConfiguration('chatgpt.promptPrefix') || e.affectsConfiguration('chatgpt.gpt3.generateCode-enabled') || e.affectsConfiguration('chatgpt.gpt3.model')) {
			setContext();
		}
	});

	const adhocCommand = vscode.commands.registerCommand("vscode-chatgpt.adhoc", async () => {
		const editor = vscode.window.activeTextEditor;

		if (!editor) {
			return;
		}

		const selection = editor.document.getText(editor.selection);
		let dismissed = false;
		if (selection) {
			await vscode.window
				.showInputBox({
					title: "Add prefix to your ad-hoc command",
					prompt: "Prefix your code with your custom prompt. i.e. Explain this",
					ignoreFocusOut: true,
					placeHolder: "Ask anything...",
					value: adhocCommandPrefix
				})
				.then((value) => {
					if (!value) {
						dismissed = true;
						return;
					}

					adhocCommandPrefix = value.trim() || '';
					context.globalState.update("chatgpt-adhoc-prompt", adhocCommandPrefix);
				});

			if (!dismissed && adhocCommandPrefix?.length > 0) {
				const currentConversation = provider.currentConversation;

				if (currentConversation) {
					provider?.sendApiRequest(adhocCommandPrefix, {
						command: "adhoc",
						code: selection,
						conversation: currentConversation,
						language: editor.document.languageId,
					});
				} else {
					console.error("adhoc - No current conversation found");
				}
			}
		}
	});

	const generateCodeCommand = vscode.commands.registerCommand(`vscode-chatgpt.generateCode`, () => {
		/*const editor = vscode.window.activeTextEditor;

		if (!editor) {
			return;
		}

		const selection = editor.document.getText(editor.selection);
		if (selection) {
			const options: ApiRequestOptions = {
				code: selection, language: editor.document.languageId
			};
			await provider?.sendApiRequest(conversation, data.message, options);
		} else {
			console.error("generateCode - No current conversation found");
		}
	}*/
	});

	context.subscriptions.push(view, actionProvider, actionCommand, actionInlineCommand,
		freeText, resetThread, newChat, closeChat, exportConversation, clearSession, configChanged, adhocCommand,
		generateCodeCommand);

	for (let i = 1; i <= 9; i++) {
		context.subscriptions.push(
			vscode.commands.registerCommand("vscode-chatgpt.viewChat" + i, async () => {
				provider.set_chat(i);
			}));
	}

	const setContext = () => {
		menuCommands.forEach(command => {
			if (command === "generateCode") {
				let generateCodeEnabled = !!vscode.workspace.getConfiguration("chatgpt").get<boolean>("gpt3.generateCode-enabled");
				const modelName = vscode.workspace.getConfiguration("chatgpt").get("gpt3.model") as string;
				const method = vscode.workspace.getConfiguration("chatgpt").get("method") as string;
				generateCodeEnabled = generateCodeEnabled && method === "GPT3 OpenAI API Key" && modelName.startsWith("code-");
				vscode.commands.executeCommand('setContext', "generateCode-enabled", generateCodeEnabled);
			} else {
				const enabled = !!vscode.workspace.getConfiguration("chatgpt.promptPrefix").get<boolean>(`${command}-enabled`);
				vscode.commands.executeCommand('setContext', `${command}-enabled`, enabled);
			}
		});
	};

	setContext();
	vscode.commands.executeCommand('setContext', 'chatGPT.chat_ids', '1');
}

export function deactivate() { }
