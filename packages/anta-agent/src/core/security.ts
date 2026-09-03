const WRAPPER_NAMES = "relevant-memories|user-persona|scene-navigation|memory-tools-guide";
const WRAPPER_TAG_RE = new RegExp(`<\\s*(\\/?)\\s*(${WRAPPER_NAMES})\\b[^>]*>`, "giu");
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export interface UntrustedTextOptions {
	maxChars?: number;
}

/** Normalize untrusted model/user text before placing it in prompts or files. */
export function sanitizeUntrustedText(text: string, options: UntrustedTextOptions = {}): string {
	const normalized = replaceInvalidSurrogates(
		text
			.replace(CONTROL_CHAR_RE, "")
			.replaceAll(WRAPPER_TAG_RE, (_match, closing: string, name: string) =>
				closing ? `<\\/${name.toLowerCase()}>` : `&lt;${name.toLowerCase()}&gt;`,
			),
	);
	const maxChars = options.maxChars;
	if (maxChars === undefined || maxChars <= 0) return normalized;
	return [...normalized].slice(0, maxChars).join("");
}

function replaceInvalidSurrogates(text: string): string {
	let result = "";
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				result += text[index] + text[index + 1];
				index += 1;
			} else {
				result += "�";
			}
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			result += "�";
		} else {
			result += text[index];
		}
	}
	return result;
}

export function containsPromptInjection(text: string): boolean {
	return /\b(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?\b|忽略(?:之前|上方|所有)指令|执行(?:命令|工具)|读取(?:密钥|secret)/iu.test(
		text,
	);
}
