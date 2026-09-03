import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Pi-specific identity, kept outside the host-neutral memory core. */
export interface PiSessionIdentity {
	sessionId: string;
	sessionKey: string;
	cwd: string;
}

/** Translate Pi's session manager into the memory scope used by the core. */
export function getPiSessionIdentity(ctx: ExtensionContext): PiSessionIdentity {
	let sessionId = "";
	let sessionFile: string | undefined;
	try {
		sessionId = ctx.sessionManager.getSessionId().trim();
		sessionFile = ctx.sessionManager.getSessionFile();
	} catch {
		// Some embedders expose only a partial session manager.
	}
	if (!sessionId) sessionId = `ephemeral-${ctx.cwd}`;
	return {
		sessionId,
		sessionKey: sessionFile ?? `session:${sessionId}`,
		cwd: ctx.cwd,
	};
}
