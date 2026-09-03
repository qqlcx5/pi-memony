#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const codingAgentEntry = require.resolve("@earendil-works/pi-coding-agent");
const codingAgentDir = dirname(dirname(codingAgentEntry));
const codingAgentCli = join(codingAgentDir, "dist", "bundle", "cli.js");
const extensionPath = join(packageDir, "dist", "anta-agent-extension.js");
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".anta-agent");

const result = spawnSync(process.execPath, [codingAgentCli, "-e", extensionPath, ...process.argv.slice(2)], {
	stdio: "inherit",
	env: {
		...process.env,
		PI_PACKAGE_DIR: packageDir,
		PI_CODING_AGENT_DIR: agentDir,
		"ANTA-AGENT_CODING_AGENT_DIR": agentDir,
	},
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
