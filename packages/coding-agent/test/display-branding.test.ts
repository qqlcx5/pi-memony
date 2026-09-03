import { afterEach, describe, expect, it, vi } from "vitest";
import { printHelp } from "../src/cli/args.ts";
import {
	getDisplayAppName,
	getDisplayAppTitle,
	getDisplayVersion,
	setDisplayBranding,
	VERSION,
} from "../src/config.ts";
import { getBuiltinSlashCommands } from "../src/core/slash-commands.ts";

afterEach(() => {
	setDisplayBranding(undefined);
	vi.restoreAllMocks();
});

describe("display branding", () => {
	it("keeps pi defaults when no override is set", () => {
		expect(getDisplayAppName()).toBe("pi");
		expect(getDisplayAppTitle()).toBe("π");
		expect(getDisplayVersion()).toBe(VERSION);
		expect(getBuiltinSlashCommands().find((command) => command.name === "quit")?.description).toBe("Quit pi");
	});

	it("uses an embedding distribution's presentation branding in help and commands", () => {
		setDisplayBranding({ name: "anta-agent", title: "anta-agent", version: "0.84.6" });
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		printHelp();

		expect(getDisplayAppName()).toBe("anta-agent");
		expect(getDisplayAppTitle()).toBe("anta-agent");
		expect(getDisplayVersion()).toBe("0.84.6");
		expect(getBuiltinSlashCommands().find((command) => command.name === "quit")?.description).toBe("Quit anta-agent");
		const output = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
		expect(output).toContain("anta-agent - AI coding assistant");
		expect(output).toContain("anta-agent [options]");
		expect(output).not.toContain("\n  pi [options]");
	});
});
