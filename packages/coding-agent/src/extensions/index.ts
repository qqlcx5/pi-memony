import type { InlineExtension } from "../core/extensions/types.ts";
import llamaExtension from "./llama/index.ts";
import piMenExtension from "./pi-men/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "pi-men", factory: piMenExtension, hidden: true },
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
];
