import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type MemeGear = "off" | "auto" | "active" | "always";

export const MEME_GEARS: readonly MemeGear[] = ["off", "auto", "active", "always"];

export interface MemeConfig {
	enabled: boolean;
	debug: boolean;
	gear: MemeGear;
}

const DEFAULT_CONFIG: MemeConfig = { enabled: true, debug: false, gear: "auto" };

function normalizeGear(value: unknown): MemeGear {
	return value === "off" || value === "auto" || value === "active" || value === "always" ? value : "auto";
}

export function memeConfigPath(root: string): string {
	return join(root, "omp-meme.json");
}

export function loadMemeConfig(root: string): MemeConfig {
	const path = memeConfigPath(root);
	if (!existsSync(path)) return { ...DEFAULT_CONFIG };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as {
			enabled?: unknown;
			debug?: unknown;
			gear?: unknown;
		};
		return { enabled: parsed?.enabled !== false, debug: parsed?.debug === true, gear: normalizeGear(parsed?.gear) };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export function saveMemeConfig(root: string, config: MemeConfig): void {
	const path = memeConfigPath(root);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2));
}
