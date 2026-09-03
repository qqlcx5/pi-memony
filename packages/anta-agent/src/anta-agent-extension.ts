import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context, SimpleStreamOptions, UserMessage } from "@earendil-works/pi-ai/compat";
import { completeSimple, contentText } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isValidMemoryType } from "./core/parse.ts";
import { getPiSessionIdentity } from "./host-adapter.ts";
import {
	AntaAgent,
	type CompletedTurn,
	type ConversationMessage,
	type LlmRunner,
	loadAntaAgentConfigFile,
	type RecallResult,
} from "./index.ts";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Built-in anta-agent memory extension: captures turns into the local four-layer
 * memory store and injects recalled context into every provider request.
 * Runs in all pi modes (TUI/RPC/print/SDK) because built-in extensions are
 * loaded by every session runtime. Disable with `memory.enabled: false` in
 * settings.json.
 */

const MEMORY_CONFIG_FILE = "memory.json";

function memoryEnabled(): boolean {
	try {
		const settings = SettingsManager.create(process.cwd(), getAgentDir()).getGlobalSettings() as {
			memory?: { enabled?: boolean };
		};
		return settings.memory?.enabled !== false;
	} catch {
		return true;
	}
}

function toConversationMessages(messages: readonly AgentMessage[]): ConversationMessage[] {
	const result: ConversationMessage[] = [];
	for (const message of messages) {
		if (!("role" in message)) continue;
		if (message.role === "user") {
			result.push({
				id: "",
				role: "user",
				content: userText(message.content),
				timestamp: message.timestamp,
			});
		} else if (message.role === "assistant") {
			// Failed/aborted turns must not pollute L0 (reference: skip on agent
			// failure); their partial text is not a real answer.
			if (message.stopReason === "error" || message.stopReason === "aborted") continue;
			const text = assistantText(message);
			if (text) {
				result.push({ id: "", role: "assistant", content: text, timestamp: message.timestamp });
			}
		}
	}
	return result;
}

function userText(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

function assistantText(message: { content: readonly { type: string; text?: string }[] }): string {
	return message.content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

function buildRunner(ctx: ExtensionContext): LlmRunner {
	return async (params) => {
		const model = ctx.model;
		if (!model) throw new Error("no model available for memory extraction");
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(auth.error);
		const options: SimpleStreamOptions = {
			maxTokens: params.maxTokens,
			...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
			...(auth.headers ? { headers: auth.headers } : {}),
			...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}),
			...(params.signal ? { signal: params.signal } : {}),
		};
		const userMessage: UserMessage = {
			role: "user",
			content: params.userPrompt,
			timestamp: Date.now(),
		};
		const context: Context = {
			systemPrompt: params.systemPrompt,
			messages: [userMessage],
		};
		const assistant: AssistantMessage = await completeSimple(model, context, options);
		if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
			throw new Error(assistant.errorMessage ?? `memory extraction LLM call failed (${assistant.stopReason})`);
		}
		return contentText(assistant.content);
	};
}

function sessionIdentity(ctx: ExtensionContext) {
	return getPiSessionIdentity(ctx);
}

function sessionKey(ctx: ExtensionContext): string {
	return sessionIdentity(ctx).sessionKey;
}

const factory: ExtensionFactory = (pi: ExtensionAPI) => {
	if (!memoryEnabled()) return;

	let memory: AntaAgent | null = null;
	let initialized = false;
	let initializePromise: Promise<void> | null = null;
	let shuttingDown = false;
	const pendingRecalls = new Map<string, Array<Promise<RecallResult | undefined>>>();
	const pendingCaptures = new Set<Promise<void>>();

	// The event bus throws once the extension runtime is stale (quit/reload);
	// logging must never break the memory pipeline, so swallow emit errors.
	const safeEmit = (channel: string, data: unknown) => {
		try {
			pi.events.emit(channel, data);
		} catch {
			// runtime torn down
		}
	};

	const getMemory = (ctx: ExtensionContext): AntaAgent => {
		if (!memory) {
			const config = loadAntaAgentConfigFile(join(getAgentDir(), MEMORY_CONFIG_FILE));
			memory = new AntaAgent({
				config,
				runner: buildRunner(ctx),
				logger: {
					debug: (message) => safeEmit("anta-agent:debug", { message }),
					info: (message) => safeEmit("anta-agent:info", { message }),
					warn: (message) => safeEmit("anta-agent:warn", { message }),
					error: (message) => safeEmit("anta-agent:error", { message }),
				},
			});
		}
		return memory;
	};

	const ensureInitialized = async (ctx: ExtensionContext): Promise<void> => {
		if (shuttingDown || initialized) return;
		if (initializePromise) return initializePromise;
		const client = getMemory(ctx);
		initializePromise = client
			.initialize()
			.then(() => {
				initialized = true;
			})
			.catch((error) => {
				// Never surface an init failure as an unhandled rejection (it would
				// kill the session); clear the gate so the next trigger can retry.
				safeEmit("anta-agent:warn", { message: `memory initialize failed: ${errorMessage(error)}` });
				throw error;
			});
		try {
			await initializePromise;
		} catch {
			// Initialization failures are deliberately fail-soft for the host.
		} finally {
			initializePromise = null;
		}
	};

	const enqueueRecall = (sessionId: string, task: Promise<RecallResult | undefined>): void => {
		const queue = pendingRecalls.get(sessionId) ?? [];
		queue.push(task);
		pendingRecalls.set(sessionId, queue);
	};

	const takeRecall = (sessionId: string): Promise<RecallResult | undefined> | undefined => {
		const queue = pendingRecalls.get(sessionId);
		if (!queue || queue.length === 0) return undefined;
		const task = queue.shift();
		if (queue.length === 0) pendingRecalls.delete(sessionId);
		return task;
	};

	const trackCapture = (task: Promise<void>): void => {
		pendingCaptures.add(task);
		void task.then(
			() => pendingCaptures.delete(task),
			() => pendingCaptures.delete(task),
		);
	};

	const waitForPending = async (
		tasks: readonly Promise<void>[],
		timeoutMs: number,
		label: string,
	): Promise<boolean> => {
		if (tasks.length === 0) return true;
		let timedOut = false;
		await Promise.race([
			Promise.allSettled(tasks),
			new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					timedOut = true;
					resolve();
				}, timeoutMs);
				timer.unref?.();
			}),
		]);
		if (timedOut) {
			safeEmit("anta-agent:warn", { message: `${label} shutdown wait timed out (${tasks.length} pending)` });
			return false;
		}
		return true;
	};

	pi.on("session_start", (event, ctx) => {
		shuttingDown = false;
		if (
			event.reason === "startup" ||
			event.reason === "reload" ||
			event.reason === "new" ||
			event.reason === "resume" ||
			event.reason === "fork"
		) {
			void ensureInitialized(ctx);
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (shuttingDown) return undefined;
		const identity = sessionIdentity(ctx);
		const client = getMemory(ctx);
		const recallTask = (async () => {
			await ensureInitialized(ctx);
			return client.recall(event.prompt);
		})();
		enqueueRecall(identity.sessionId, recallTask);
		const recall = await recallTask;
		if (!recall) return undefined;
		if (recall.appendSystemContext) {
			return { systemPrompt: `${event.systemPrompt}\n\n${recall.appendSystemContext}` };
		}
		return undefined;
	});

	pi.on("context", async (event, ctx) => {
		const recallTask = takeRecall(sessionIdentity(ctx).sessionId);
		if (!recallTask) return undefined;
		const recall = await recallTask;
		if (!recall?.prependContext) return undefined;
		const messages = [...event.messages];
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message && "role" in message && message.role === "user") {
				messages[i] = prependToUserMessage(message, recall.prependContext);
				return { messages };
			}
		}
		return undefined;
	});

	pi.on("agent_end", (event, ctx) => {
		if (shuttingDown) return;
		const identity = sessionIdentity(ctx);
		const client = getMemory(ctx);
		const turn: CompletedTurn = {
			sessionId: identity.sessionId,
			sessionKey: identity.sessionKey,
			cwd: identity.cwd,
			messages: toConversationMessages(event.messages),
		};
		trackCapture(client.capture(turn));
	});

	pi.on("agent_settled", (_event, ctx) => {
		pendingRecalls.delete(sessionIdentity(ctx).sessionId);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		shuttingDown = true;
		pendingRecalls.delete(sessionIdentity(ctx).sessionId);
		const pending = [...pendingCaptures];
		const capturesSettled = await waitForPending(pending, 5000, "capture");
		if (!capturesSettled) {
			// A capture may still be inside SQLite. Keep the shared core alive rather
			// than closing its store underneath that operation.
			initializePromise = null;
			initialized = false;
			shuttingDown = false;
			return;
		}
		if (memory) {
			const flush = memory.flush();
			const flushSettled = await waitForPending([flush], 5000, "pipeline flush");
			if (!flushSettled) {
				initializePromise = null;
				initialized = false;
				shuttingDown = false;
				return;
			}
			await memory.destroy();
			memory = null;
		}
		initializePromise = null;
		initialized = false;
		shuttingDown = false;
	});

	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description:
			"Search long-term agent memory (structured facts about the user, projects, decisions, preferences, rules, methods). Use when the injected memory context is not enough.",
		promptSnippet: "memory_search: search long-term memory (preferences, events, rules)",
		parameters: Type.Object({
			query: Type.String({ description: "Free-text search query" }),
			limit: Type.Optional(Type.Number({ description: "Maximum results, 1-20 (default 10)" })),
			type: Type.Optional(
				Type.String({
					description:
						"Filter by memory type: persona | episodic | instruction | work_fact | work_task | work_method | work_artifact",
				}),
			),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const hits = await getMemory(ctx).searchMemories({
				query: params.query,
				limit: safeLimit(params.limit),
				...(params.type && isValidMemoryType(params.type, true) ? { type: params.type } : {}),
			});
			const text =
				hits.length === 0
					? "No memories found for this query."
					: hits.map((hit) => `- [${hit.type}] (${hit.priority}) ${hit.content}`).join("\n");
			return { content: [{ type: "text", text }], details: { count: hits.length } };
		},
	});

	pi.registerTool({
		name: "conversation_search",
		label: "Conversation Search",
		description:
			"Search raw past conversations (L0). Use to find exact wording, timelines, or details that structured memory does not preserve.",
		promptSnippet: "conversation_search: search past conversation transcripts",
		parameters: Type.Object({
			query: Type.String({ description: "Free-text search query" }),
			limit: Type.Optional(Type.Number({ description: "Maximum results, 1-20 (default 10)" })),
			sessionKey: Type.Optional(Type.String({ description: "Restrict search to one session file" })),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const hits = await getMemory(ctx).searchConversations({
				query: params.query,
				limit: safeLimit(params.limit),
				...(params.sessionKey?.trim() ? { sessionKey: params.sessionKey.trim() } : {}),
			});
			const text =
				hits.length === 0
					? "No conversations found for this query."
					: hits
							.map(
								(hit) =>
									`- [${new Date(hit.timestamp).toISOString()}] [${hit.role}] ${hit.content.slice(0, 500)}`,
							)
							.join("\n");
			return { content: [{ type: "text", text }], details: { count: hits.length } };
		},
	});

	pi.registerCommand("remember", {
		description: "Save a long-term memory (usage: /remember <text>)",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify("Usage: /remember <text>", "warning");
				return;
			}
			try {
				const record = await getMemory(ctx).remember(text, { sessionKey: sessionKey(ctx), cwd: ctx.cwd });
				ctx.ui.notify(`Saved memory ${record.id}: ${text}`);
			} catch (error) {
				ctx.ui.notify(`Failed to save memory: ${errorMessage(error)}`, "error");
			}
		},
	});

	pi.registerCommand("memory", {
		description: "Show anta-agent memory status",
		handler: async (_args, ctx) => {
			try {
				const client = getMemory(ctx);
				const stats = client.stats();
				const lines = [
					"anta-agent memory status:",
					`  L1 memories: ${stats.l1Count}`,
					`  L0 conversations: ${stats.l0Count}`,
					`  L2 scenes: ${stats.sceneCount}`,
					`  L3 persona: ${stats.personaExists ? "yes" : "no"}`,
					`  recall strategy: ${stats.strategy} (embedding: ${stats.embedding})`,
					`  last extraction (L1): ${stats.lastL1At ?? "never"}`,
					`  last scene pass (L2): ${stats.lastL2At ?? "never"}`,
					`  last persona pass (L3): ${stats.lastL3At ?? "never"}`,
				];
				ctx.ui.notify(lines.join("\n"));
			} catch (error) {
				ctx.ui.notify(`anta-agent status failed: ${errorMessage(error)}`, "error");
			}
		},
	});
};

function safeLimit(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 10;
	return Math.min(20, Math.max(1, Math.trunc(value)));
}

function prependToUserMessage(message: AgentMessage, prepend: string): AgentMessage {
	if (!("role" in message) || message.role !== "user") return message;
	if (typeof message.content === "string") {
		return { ...message, content: `${prepend}\n\n${message.content}` };
	}
	return {
		...message,
		content: [{ type: "text", text: prepend }, ...message.content],
	};
}

export default factory;
