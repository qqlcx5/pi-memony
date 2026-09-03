#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
// Resolve the package root through its public entry point. Do not access
// `@earendil-works/pi-coding-agent/package.json`: its exports map intentionally
// does not expose package metadata to consumers.
const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const codingAgentDir = dirname(dirname(codingAgentEntry));
const codingAgentCli = [join(codingAgentDir, "dist", "bundle", "cli.js"), join(codingAgentDir, "dist", "cli.js")].find(
	(file) => existsSync(file),
);
if (!codingAgentCli) {
	throw new Error(`Cannot find the pi-coding-agent CLI under ${codingAgentDir}`);
}
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
