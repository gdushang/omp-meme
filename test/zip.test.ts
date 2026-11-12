import { describe, expect, test } from "bun:test";
import { readZip, writeZip } from "../src/zip.ts";

describe("zip", () => {
	test("round-trips text and binary entries", () => {
		const binary = new Uint8Array(1024);
		for (let i = 0; i < binary.length; i++) binary[i] = (i * 37) % 256;
		const entries = [
			{ name: "pack/manifest.json", data: new TextEncoder().encode('{"name":"测试图库"}') },
			{ name: "pack/memes/happy/ok.jpg", data: binary },
			{ name: "pack/memes/sad/哭.png", data: new Uint8Array([1, 2, 3]) },
		];
		const decoded = readZip(writeZip(entries));
		expect(decoded.map(entry => entry.name)).toEqual(entries.map(entry => entry.name));
		for (let i = 0; i < entries.length; i++) {
			expect(Buffer.from(decoded[i]!.data).equals(Buffer.from(entries[i]!.data))).toBe(true);
		}
	});

	test("rejects data that is not a zip", () => {
		expect(() => readZip(new Uint8Array([1, 2, 3, 4]))).toThrow();
	});
});
