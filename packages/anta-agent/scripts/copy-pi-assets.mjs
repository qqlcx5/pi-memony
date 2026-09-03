import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const piDist = join(packageDir, "..", "coding-agent", "dist");
const targetDist = join(packageDir, "dist");

for (const relativePath of [
	"modes/interactive/theme",
	"modes/interactive/assets",
	"core/export-html",
]) {
	const source = join(piDist, relativePath);
	const target = join(targetDist, relativePath);
	if (!existsSync(source)) {
		throw new Error(`Missing pi runtime asset directory: ${source}. Run the root build first.`);
	}
	mkdirSync(dirname(target), { recursive: true });
	cpSync(source, target, { recursive: true });
}

for (const relativePath of ["README.md", "CHANGELOG.md", "docs", "examples"]) {
	const source = join(packageDir, "..", "coding-agent", relativePath);
	const target = join(packageDir, relativePath);
	if (existsSync(source) && !existsSync(target)) {
		cpSync(source, target, { recursive: true });
	}
}
