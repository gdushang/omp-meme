import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readZip, writeZip, type ZipEntry } from "./zip.ts";

/** Formats every terminal graphics protocol draws as a still frame. */
export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);

const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const TAG_ALIASES: Record<string, string[]> = {
	happy: ["happy", "开心", "高兴", "快乐", "笑", "得意", "点赞", "ok", "好耶"],
	angry: ["angry", "生气", "愤怒", "嫌弃", "不爽"],
	sad: ["sad", "难过", "伤心", "哭", "求饶", "委屈"],
	shy: ["shy", "害羞", "偷看", "脸红"],
	confused: ["confused", "疑惑", "问号", "无语", "震惊", "加载", "懵"],
	daily: ["daily", "日常", "干饭", "吃饭", "睡觉", "早上好", "躺平", "摸鱼"],
};

export interface Meme {
	path: string;
	pack: string;
	packName: string;
	tag: string;
	caption: string;
	keywords: string[];
	bundled: boolean;
}

export interface PackInfo {
	id: string;
	name: string;
	dir: string;
	count: number;
	bundled: boolean;
}

export interface PickMiss {
	ok: false;
	reason: string;
	tags: string[];
	tagStats: Record<string, number>;
}

export interface PickHit {
	ok: true;
	meme: Meme;
}

export type PickResult = PickHit | PickMiss;

export interface LibraryRoot {
	dir: string;
	bundled: boolean;
}

function defaultRoots(): LibraryRoot[] {
	const configured = process.env.OMP_MEME_DIR?.trim();
	const userRoot = configured ? resolve(configured) : join(homedir(), ".omp", "memes");
	const bundled = fileURLToPath(new URL("../memes", import.meta.url));
	return [
		{ dir: userRoot, bundled: false },
		{ dir: bundled, bundled: true },
	];
}

function readManifest(dir: string): { id?: string; name?: string; tags?: string[]; description?: string } {
	for (const file of ["manifest.json", "meme.json"]) {
		const path = join(dir, file);
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			if (parsed && typeof parsed === "object") return parsed;
		} catch {
			// A broken manifest must not hide the images next to it.
		}
	}
	return {};
}

function stemCaption(file: string): string {
	return basename(file, extname(file))
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function walkImages(dir: string, out: string[], depth = 0): void {
	if (depth > 6) return;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (name.startsWith(".")) continue;
		const path = join(dir, name);
		let stat: Stats;
		try {
			stat = statSync(path);
		} catch {
			continue;
		}
		if (stat.isDirectory()) walkImages(path, out, depth + 1);
		else if (IMAGE_EXTENSIONS.has(extname(name).toLowerCase())) out.push(path);
	}
}

function collectPackFiles(packDir: string): { imageRoot: string; files: string[] } {
	const nested = join(packDir, "memes");
	if (existsSync(nested) && statSync(nested).isDirectory()) {
		const files: string[] = [];
		walkImages(nested, files);
		if (files.length > 0) return { imageRoot: nested, files };
	}
	const files: string[] = [];
	walkImages(packDir, files);
	return { imageRoot: packDir, files };
}

function imageTag(imageRoot: string, file: string): string {
	const parts = relative(imageRoot, dirname(file)).split(/[\\/]/).filter(Boolean);
	return parts[0] ?? "default";
}

function sanitizeFileName(name: string): string {
	const base = basename(name.replaceAll("\\", "/"))
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
		.trim();
	return base || "image";
}

function uniqueFileName(dir: string, name: string): string {
	if (!existsSync(join(dir, name))) return name;
	const extension = extname(name);
	const stem = basename(name, extension);
	for (let index = 1; index < 1000; index++) {
		const candidate = `${stem}-${index}${extension}`;
		if (!existsSync(join(dir, candidate))) return candidate;
	}
	return `${stem}-${Date.now()}${extension}`;
}

function safeUrlName(url: URL): string {
	const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
	try {
		return decodeURIComponent(last) || "download";
	} catch {
		return last || "download";
	}
}

function safeEntryName(name: string): string | undefined {
	const normalized = name.replaceAll("\\", "/").replace(/^\/+/, "");
	const parts = normalized.split("/");
	if (parts.length === 0 || parts.some(part => part === ".." || part === "")) return undefined;
	return parts.join("/");
}

export class MemeLibrary {
	readonly roots: LibraryRoot[];
	#memes: Meme[] | undefined;
	#packs: PackInfo[] | undefined;

	constructor(roots: LibraryRoot[] = defaultRoots()) {
		this.roots = roots;
	}

	get userRoot(): string {
		return this.roots.find(root => !root.bundled)?.dir ?? this.roots[0]!.dir;
	}

	scan(): this {
		const memes: Meme[] = [];
		const packs: PackInfo[] = [];
		for (const root of this.roots) {
			if (!existsSync(root.dir) || !statSync(root.dir).isDirectory()) continue;
			let entries: string[];
			try {
				entries = readdirSync(root.dir);
			} catch {
				continue;
			}
			for (const name of entries) {
				if (name.startsWith(".") || name === "node_modules") continue;
				const dir = join(root.dir, name);
				let stat: Stats;
				try {
					stat = statSync(dir);
				} catch {
					continue;
				}
				if (!stat.isDirectory()) continue;
				const manifest = readManifest(dir);
				const id = manifest.id?.trim() || name;
				const packName = manifest.name?.trim() || name;
				const packTags = Array.isArray(manifest.tags) ? manifest.tags.filter(tag => typeof tag === "string") : [];
				const { imageRoot, files } = collectPackFiles(dir);
				if (files.length === 0) continue;
				packs.push({ id, name: packName, dir, count: files.length, bundled: root.bundled });
				for (const path of files) {
					const caption = stemCaption(path);
					const tag = imageTag(imageRoot, path);
					const keywords = [
						tag,
						...caption.split(/\s+/).filter(Boolean),
						...packTags,
						packName,
						manifest.description ?? "",
					].filter(Boolean);
					memes.push({ path, pack: id, packName, tag, caption, keywords, bundled: root.bundled });
				}
			}
			// Loose images directly under the root form a default pack.
			const loose: string[] = [];
			for (const name of entries) {
				if (name.startsWith(".")) continue;
				const path = join(root.dir, name);
				try {
					if (!statSync(path).isFile()) continue;
				} catch {
					continue;
				}
				if (IMAGE_EXTENSIONS.has(extname(name).toLowerCase())) loose.push(path);
			}
			if (loose.length > 0) {
				const id = "default";
				const existing = packs.find(pack => pack.id === id && pack.bundled === root.bundled);
				if (!existing) packs.push({ id, name: "默认图库", dir: root.dir, count: loose.length, bundled: root.bundled });
				for (const path of loose) {
					const caption = stemCaption(path);
					memes.push({
						path,
						pack: id,
						packName: "默认图库",
						tag: "daily",
						caption,
						keywords: ["daily", ...caption.split(/\s+/).filter(Boolean)],
						bundled: root.bundled,
					});
				}
			}
		}
		memes.sort((a, b) => a.path.localeCompare(b.path));
		this.#memes = memes;
		this.#packs = packs;
		return this;
	}

	#ensure(): void {
		if (!this.#memes || !this.#packs) this.scan();
	}

	get memes(): readonly Meme[] {
		this.#ensure();
		return this.#memes!;
	}

	get packs(): readonly PackInfo[] {
		this.#ensure();
		return this.#packs!;
	}

	invalidate(): void {
		this.#memes = undefined;
		this.#packs = undefined;
	}

	stats(): { packs: number; images: number; tags: Record<string, number> } {
		const tags: Record<string, number> = {};
		for (const meme of this.memes) tags[meme.tag] = (tags[meme.tag] ?? 0) + 1;
		return { packs: this.packs.length, images: this.memes.length, tags };
	}

	list(options: { tag?: string; query?: string; limit?: number } = {}): Meme[] {
		const matches = this.#filter(options);
		return options.limit === undefined ? matches : matches.slice(0, options.limit);
	}

	#filter(options: { tag?: string; query?: string; pack?: string }): Meme[] {
		const tagWords = options.tag ? expandTag(options.tag) : undefined;
		const query = options.query?.trim().toLowerCase();
		const pack = options.pack?.trim().toLowerCase();
		return this.memes.filter(meme => {
			if (pack && meme.pack.toLowerCase() !== pack && meme.packName.toLowerCase() !== pack) return false;
			if (tagWords && !tagWords.includes(meme.tag.toLowerCase())) return false;
			if (query) {
				const haystack = [meme.caption, meme.tag, meme.packName, ...meme.keywords].join(" ").toLowerCase();
				const words = query.split(/\s+/).filter(Boolean);
				if (!words.every(word => haystack.includes(word))) return false;
			}
			return true;
		});
	}

	pick(options: { tag?: string; query?: string; exclude?: ReadonlySet<string> } = {}): PickResult {
		let candidates = this.#filter(options);
		if (options.exclude && options.exclude.size > 0) {
			const narrowed = candidates.filter(meme => !options.exclude!.has(meme.path));
			if (narrowed.length > 0) candidates = narrowed;
		}
		const tags: Record<string, number> = {};
		for (const meme of this.memes) tags[meme.tag] = (tags[meme.tag] ?? 0) + 1;
		if (candidates.length === 0) {
			return {
				ok: false,
				reason: options.tag || options.query ? "没有匹配的表情包" : "图库为空",
				tags: Object.keys(tags),
				tagStats: tags,
			};
		}
		const meme = candidates[Math.floor(Math.random() * candidates.length)]!;
		return { ok: true, meme };
	}

	/** Copy a directory or extract a ZIP into the user library root. */
	importFrom(sourcePath: string): { packId: string; dest: string; files: number } {
		const source = resolve(sourcePath);
		if (!existsSync(source)) throw new Error(`路径不存在：${source}`);
		const stat = statSync(source);
		mkdirSync(this.userRoot, { recursive: true });
		if (stat.isDirectory()) {
			const packId = basename(source);
			const dest = join(this.userRoot, packId);
			if (existsSync(dest)) throw new Error(`图库已存在：${dest}`);
			cpSync(source, dest, { recursive: true });
			const { files } = collectPackFiles(dest);
			this.invalidate();
			return { packId, dest, files: files.length };
		}
		if (stat.isFile()) {
			const extension = extname(source).toLowerCase();
			if (extension === ".zip") {
				return this.importArchive(readFileSync(source), basename(source, extension));
			}
			if (IMAGE_EXTENSIONS.has(extension)) {
				return this.importImage(readFileSync(source), basename(source));
			}
			throw new Error("只支持导入目录、.zip 图库包或 png/jpg/webp/bmp 图片");
		}
		throw new Error("不支持的导入来源");
	}

	/** Extract ZIP bytes into `<userRoot>/<packId>`; a single top-level folder becomes the pack id. */
	importArchive(data: Uint8Array, fallbackId: string): { packId: string; dest: string; files: number } {
		mkdirSync(this.userRoot, { recursive: true });
		const entries = readZip(data);
		const usable = entries
			.map(entry => ({ ...entry, name: safeEntryName(entry.name) }))
			.filter((entry): entry is ZipEntry => entry.name !== undefined);
		if (usable.length === 0) throw new Error("ZIP 内没有可用文件");
		const tops = new Set(usable.map(entry => entry.name.split("/")[0]!));
		const prefix = tops.size === 1 && usable.every(entry => entry.name.includes("/")) ? [...tops][0]! : undefined;
		const packId = (prefix ?? fallbackId).replace(/[^\w.\-\u4e00-\u9fff]+/g, "-");
		const dest = join(this.userRoot, packId);
		if (existsSync(dest)) throw new Error(`图库已存在：${dest}`);
		let count = 0;
		for (const entry of usable) {
			const relativeName = prefix ? entry.name.slice(prefix.length + 1) : entry.name;
			if (!relativeName) continue;
			const target = join(dest, relativeName);
			if (!isPathInside(target, dest)) continue;
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, entry.data);
			if (IMAGE_EXTENSIONS.has(extname(target).toLowerCase())) count++;
		}
		this.invalidate();
		return { packId, dest, files: count };
	}

	/** Store one static image under the shared `imported` pack. */
	importImage(data: Uint8Array, filename: string): { packId: string; dest: string; file: string; files: number } {
		const packId = "imported";
		const packDir = join(this.userRoot, packId);
		const imageDir = join(packDir, "memes");
		mkdirSync(imageDir, { recursive: true });
		const manifest = join(packDir, "manifest.json");
		if (!existsSync(manifest)) {
			writeFileSync(manifest, JSON.stringify({ id: packId, name: "导入图片", tags: [packId] }, null, 2));
		}
		const name = uniqueFileName(imageDir, sanitizeFileName(filename));
		const file = join(imageDir, name);
		writeFileSync(file, data);
		this.invalidate();
		return { packId, dest: packDir, file, files: 1 };
	}

	/** Download a ZIP pack from an http(s) URL. */
	async importFromUrl(url: string): Promise<{ packId: string; dest: string; files: number; kind: "zip" }> {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new Error(`不是有效的 URL：${url}`);
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new Error("只支持 http/https URL");
		}
		let response: Response;
		try {
			response = await fetch(parsed, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		} catch (error) {
			throw new Error(`下载失败：${error instanceof Error ? error.message : String(error)}`);
		}
		if (!response.ok) throw new Error(`下载失败：HTTP ${response.status} ${response.statusText}`.trim());
		const declaredLength = Number(response.headers.get("content-length") ?? 0);
		if (declaredLength > MAX_DOWNLOAD_BYTES) {
			throw new Error(`文件过大（${Math.round(declaredLength / 1024 / 1024)} MB，上限 64 MB）`);
		}
		const data = new Uint8Array(await response.arrayBuffer());
		if (data.byteLength > MAX_DOWNLOAD_BYTES) throw new Error("文件超过 64 MB 上限");

		const rawName = safeUrlName(parsed);
		const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
		const looksZip =
			contentType.includes("zip") ||
			rawName.toLowerCase().endsWith(".zip") ||
			(data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04);
		if (!looksZip) throw new Error("URL 必须指向 ZIP 图库包");
		const fallbackId = rawName.replace(/\.zip$/i, "") || "imported";
		const result = this.importArchive(data, fallbackId);
		return { ...result, kind: "zip" };
	}

	/** Export one pack (or every user pack) as a ZIP archive. */
	exportToZip(destPath: string, packId?: string): { dest: string; packs: string[]; files: number } {
		this.#ensure();
		const chosen = packId
			? this.packs.filter(pack => pack.id === packId || pack.name === packId)
			: this.packs.filter(pack => !pack.bundled);
		const packs = chosen.length > 0 ? chosen : this.packs;
		if (packs.length === 0) throw new Error("没有可导出的图库");
		const entries: ZipEntry[] = [];
		let files = 0;
		for (const pack of packs) {
			const walk = (dir: string): void => {
				for (const name of readdirSync(dir)) {
					if (name.startsWith(".")) continue;
					const path = join(dir, name);
					const stat = statSync(path);
					if (stat.isDirectory()) {
						walk(path);
						continue;
					}
					const rel = relative(pack.dir, path).replaceAll("\\", "/");
					entries.push({ name: `${pack.id}/${rel}`, data: readFileSync(path) });
					if (IMAGE_EXTENSIONS.has(extname(name).toLowerCase())) files++;
				}
			};
			walk(pack.dir);
		}
		const dest = resolve(destPath);
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, writeZip(entries));
		return { dest, packs: packs.map(pack => pack.id), files };
	}
}

function expandTag(tag: string): string[] {
	const normalized = tag.trim().toLowerCase();
	const words = new Set([normalized]);
	for (const [canonical, aliases] of Object.entries(TAG_ALIASES)) {
		if (canonical === normalized || aliases.includes(normalized)) {
			words.add(canonical);
			for (const alias of aliases) words.add(alias);
		}
	}
	return [...words];
}

export function isPathInside(child: string, parent: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function libraryRootLabel(roots: readonly LibraryRoot[]): string {
	return roots.map(root => `${root.bundled ? "内置" : "用户"}：${root.dir}`).join("\n");
}
