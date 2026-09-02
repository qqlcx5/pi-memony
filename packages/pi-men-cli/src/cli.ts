#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { main } from "@earendil-works/pi-coding-agent";
import { configureHttpDispatcher } from "./http-dispatcher.ts";

// Mirror the pi CLI startup so behavior is identical.
process.title = "pi-men";
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
process.emitWarning = (() => {}) as typeof process.emitWarning;

// Configure undici's global dispatcher before provider SDKs issue requests.
configureHttpDispatcher();

// pi-men is an independent product: config, auth, sessions, and memory live
// under ~/.pi-men unless the user points PI_CODING_AGENT_DIR elsewhere.
process.env.PI_CODING_AGENT_DIR ??= join(homedir(), ".pi-men");

await main(process.argv.slice(2));
