import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { PiMen } from "@earendil-works/pi-men";
import { afterEach, describe, expect, it } from "vitest";
import piMenExtension from "../../src/extensions/pi-men/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

/**
 * pi-men adapter extension against the shared suite harness. PI_CODING_AGENT_DIR
 * is redirected to a temp dir so the adapter's memory.json and data directory
 * never touch the real home directory.
 */
describe("pi-men built-in memory extension", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		}
		delete process.env.PI_CODING_AGENT_DIR;
	});

	async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate()) return;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(predicate(), "condition not met before timeout").toBe(true);
	}

	function setupAgentDir(): string {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-men-agentdir-"));
		const dataDir = join(agentDir, "memory-data");
		mkdirSync(dataDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(join(agentDir, "memory.json"), JSON.stringify({ dataDir }));
		tempDirs.push(agentDir);
		return agentDir;
	}

	it("registers tools and commands and persists captured turns to L0", async () => {
		const agentDir = setupAgentDir();
		const seeder = new PiMen({ config: { dataDir: join(agentDir, "memory-data") }, runner: async () => "" });
		await seeder.initialize();

		const harness = await createHarness({ extensionFactories: [piMenExtension] });
		harnesses.push(harness);
		expect(harness.session.getActiveToolNames()).toContain("memory_search");
		expect(harness.session.getActiveToolNames()).toContain("conversation_search");

		harness.setResponses([fauxAssistantMessage("ack")]);
		await harness.session.prompt("remember the parser decision");
		await waitFor(() => seeder.stats().l0Count === 2);

		// Persisted session messages stay clean: injection is per-request only.
		expect(getMessageText(harness.session.messages[0]!)).toBe("remember the parser decision");
		seeder.destroy();
	});

	it("injects recalled memories into the provider request without polluting the session", async () => {
		const agentDir = setupAgentDir();
		const dataDir = join(agentDir, "memory-data");
		const seeder = new PiMen({ config: { dataDir }, runner: async () => "" });
		await seeder.initialize();
		await seeder.remember("The user prefers tabs over spaces", { sessionKey: "seed" });

		const harness = await createHarness({
			extensionFactories: [piMenExtension],
		});
		harnesses.push(harness);

		let requestSystemPrompt = "";
		let lastUserRequestText = "";
		harness.setResponses([
			(context) => {
				requestSystemPrompt = context.systemPrompt ?? "";
				const lastUser = [...context.messages].reverse().find((message) => message.role === "user");
				lastUserRequestText = getMessageText(lastUser);
				return fauxAssistantMessage("ack");
			},
		]);

		await harness.session.prompt("What indentation style do I prefer?");
		expect(lastUserRequestText).toContain("<relevant-memories>");
		expect(lastUserRequestText).toContain("tabs over spaces");
		expect(requestSystemPrompt).toContain("<memory-tools-guide>");
		expect(getMessageText(harness.session.messages[0]!)).not.toContain("<relevant-memories>");
		seeder.destroy();
	});

	it("handles /remember as an extension command", async () => {
		const agentDir = setupAgentDir();
		const seeder = new PiMen({ config: { dataDir: join(agentDir, "memory-data") }, runner: async () => "" });
		await seeder.initialize();

		const harness = await createHarness({ extensionFactories: [piMenExtension] });
		harnesses.push(harness);
		await harness.session.prompt("/remember always run npm run check before commit");
		await waitFor(() => seeder.stats().l1Count === 1);
		seeder.destroy();
	});
});
