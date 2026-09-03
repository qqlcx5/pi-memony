#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { main } from "@earendil-works/pi-coding-agent";
import antaAgentExtension from "./anta-agent-extension.ts";
import { configureHttpDispatcher } from "./http-dispatcher.ts";

// Mirror the pi CLI startup so behavior is identical.
process.title = "anta-agent";
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
process.emitWarning = (() => {}) as typeof process.emitWarning;

// Configure undici's global dispatcher before provider SDKs issue requests.
configureHttpDispatcher();

// anta-agent is an independent product: config, auth, sessions, and memory
// live under ~/.anta-agent unless the user points PI_CODING_AGENT_DIR elsewhere.
process.env.PI_CODING_AGENT_DIR ??= join(homedir(), ".anta-agent");

await main(process.argv.slice(2), {
	extensionFactories: [{ name: "anta-agent-memory", factory: antaAgentExtension, hidden: true }],
});
