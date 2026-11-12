import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemeLibrary } from "../src/library.ts";
import { readZip, writeZip } from "../src/zip.ts";

const temp = mkdtempSync(join(tmpdir(), "omp-meme-test-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

function write(path: string, data: string | Uint8Array) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, data);
}

describe("library", () => {
	test("scans packs, tags, captions and manifests", () => {
		const root = join(temp, "root");
		write(join(root, "fish", "manifest.json"), JSON.stringify({ id: "fish", name: "大肥鱼", tags: ["whale"] }));
		write(join(root, "fish", "memes", "happy", "deyi.jpg"), "a");
		write(join(root, "fish", "memes", "sad", "求饶.png"), "b");
		write(join(root, "fish", "memes", "notes.txt"), "ignored");
		write(join(root, "loose.webp"), "c");

		const library = new MemeLibrary([{ dir: root, bundled: false }]).scan();
		expect(library.packs.map(pack => pack.id).sort()).toEqual(["default", "fish"]);
		expect(library.stats().images).toBe(3);

		const happy = library.list({ tag: "happy" });
		expect(happy).toHaveLength(1);
		expect(happy[0]!.caption).toBe("deyi");
		expect(happy[0]!.keywords).toContain("whale");

		const queried = library.list({ query: "求饶" });
		expect(queried).toHaveLength(1);
		expect(queried[0]!.tag).toBe("sad");

		const chineseTag = library.list({ tag: "开心" });
		expect(chineseTag).toHaveLength(1);

		const pick = library.pick({ tag: "sad" });
		expect(pick.ok).toBe(true);
		if (pick.ok) expect(pick.meme.caption).toBe("求饶");

		const miss = library.pick({ query: "不存在" });
		expect(miss.ok).toBe(false);
	});

	test("imports a directory and exports it as a readable zip", () => {
		const root = join(temp, "import-root");
		const source = join(temp, "source-pack");
		write(join(source, "manifest.json"), JSON.stringify({ id: "source-pack", name: "导入包" }));
		write(join(source, "memes", "daily", "ganfan.jpg"), new Uint8Array([9, 8, 7]));

		const library = new MemeLibrary([{ dir: root, bundled: false }]);
		const imported = library.importFrom(source);
		expect(imported.packId).toBe("source-pack");
		expect(imported.files).toBe(1);
		expect(library.scan().list({ tag: "daily" })).toHaveLength(1);

		const dest = join(temp, "export.zip");
		const exported = library.exportToZip(dest, "source-pack");
		expect(exported.files).toBe(1);
		const entries = readZip(readFileSync(dest));
		expect(entries.map(entry => entry.name)).toContain("source-pack/memes/daily/ganfan.jpg");
	});

	test("imports a single image file", () => {
		const root = join(temp, "image-root");
		const source = join(temp, "one.png");
		writeFileSync(source, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
		const library = new MemeLibrary([{ dir: root, bundled: false }]);
		library.importFrom(source);
		const memes = library.scan().list({ query: "one" });
		expect(memes).toHaveLength(1);
		expect(memes[0]!.path.endsWith("one.png")).toBe(true);
	});

	test("imports a zip pack and a single image from URLs", async () => {
		const root = join(temp, "url-root");
		const library = new MemeLibrary([{ dir: root, bundled: false }]);
		const zipBytes = writeZip([
			{ name: "net/memes/happy/x.jpg", data: new Uint8Array([1, 2, 3]) },
			{ name: "net/manifest.json", data: new TextEncoder().encode('{"name":"网络图库"}') },
		]);
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const path = new URL(request.url).pathname;
				if (path === "/pack.zip") {
					return new Response(zipBytes, { headers: { "content-type": "application/zip" } });
				}
				if (path === "/sticker.png") {
					return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
						headers: { "content-type": "image/png" },
					});
				}
				if (path === "/anim.gif") {
					return new Response(new Uint8Array([0x47, 0x49, 0x46]), { headers: { "content-type": "image/gif" } });
				}
				return new Response("not found", { status: 404 });
			},
		});
		try {
			const base = `http://127.0.0.1:${server.port}`;
			const pack = await library.importFromUrl(`${base}/pack.zip`);
			expect(pack.kind).toBe("zip");
			expect(pack.packId).toBe("net");
			expect(pack.files).toBe(1);

			await expect(library.importFromUrl(`${base}/sticker.png`)).rejects.toThrow("ZIP");
			await expect(library.importFromUrl(`${base}/anim.gif`)).rejects.toThrow("ZIP");
			await expect(library.importFromUrl(`${base}/missing.zip`)).rejects.toThrow();
			expect(library.scan().list({ tag: "happy" })).toHaveLength(1);
		} finally {
			server.stop(true);
		}
	});

	test("imports a zip and strips a single top-level folder", () => {
		const root = join(temp, "zip-root");
		const source = join(temp, "pack.zip");
		writeFileSync(
			source,
			writeZip([
				{ name: "pack/memes/happy/ok.jpg", data: new Uint8Array([1]) },
				{ name: "pack/manifest.json", data: new TextEncoder().encode('{"name":"ZIP 包"}') },
			]),
		);
		const library = new MemeLibrary([{ dir: root, bundled: false }]);
		const imported = library.importFrom(source);
		expect(imported.packId).toBe("pack");
		expect(library.scan().list({ tag: "happy" })).toHaveLength(1);
	});
});
