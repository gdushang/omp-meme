import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface MemeConfig {
	enabled: boolean;
	debug: boolean;
}

const DEFAULT_CONFIG: MemeConfig = { enabled: true, debug: false };

export function memeConfigPath(root: string): string {
	return join(root, "omp-meme.json");
}

export function loadMemeConfig(root: string): MemeConfig {
	const path = memeConfigPath(root);
	if (!existsSync(path)) return { ...DEFAULT_CONFIG };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { enabled?: unknown; debug?: unknown };
		return { enabled: parsed?.enabled !== false, debug: parsed?.debug === true };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export function saveMemeConfig(root: string, config: MemeConfig): void {
	const path = memeConfigPath(root);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2));
}
