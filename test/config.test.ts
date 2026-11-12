import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemeConfig, memeConfigPath, saveMemeConfig } from "../src/config.ts";

const temp = mkdtempSync(join(tmpdir(), "omp-meme-config-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("meme config", () => {
	test("defaults to enabled without debug text", () => {
		expect(loadMemeConfig(join(temp, "missing"))).toEqual({ enabled: true, debug: false });
	});

	test("round-trips the switches", () => {
		saveMemeConfig(temp, { enabled: false, debug: true });
		expect(loadMemeConfig(temp)).toEqual({ enabled: false, debug: true });
		expect(JSON.parse(readFileSync(memeConfigPath(temp), "utf8"))).toEqual({ enabled: false, debug: true });
		saveMemeConfig(temp, { enabled: true, debug: false });
		expect(loadMemeConfig(temp)).toEqual({ enabled: true, debug: false });
	});

	test("falls back to enabled without debug text on corrupt config", () => {
		saveMemeConfig(temp, { enabled: false, debug: true });
		writeFileSync(memeConfigPath(temp), "{broken");
		expect(loadMemeConfig(temp)).toEqual({ enabled: true, debug: false });
	});
});
