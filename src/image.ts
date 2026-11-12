import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

const MIME_BY_EXTENSION: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

interface CachedImage {
	mtimeMs: number;
	data: string;
	mimeType: string;
}

const CACHE_LIMIT = 64;
const cache = new Map<string, CachedImage>();

export function mimeForPath(path: string): string | undefined {
	return MIME_BY_EXTENSION[extname(path).toLowerCase()];
}

export function loadMemeImage(path: string): { data: string; mimeType: string } | undefined {
	const mimeType = mimeForPath(path);
	if (!mimeType) return undefined;
	let mtimeMs: number;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		return undefined;
	}
	const cached = cache.get(path);
	if (cached && cached.mtimeMs === mtimeMs) return cached;
	let raw: Buffer;
	try {
		raw = readFileSync(path);
	} catch {
		return undefined;
	}
	const entry = { mtimeMs, data: raw.toString("base64"), mimeType };
	if (cache.size >= CACHE_LIMIT) cache.clear();
	cache.set(path, entry);
	return entry;
}
