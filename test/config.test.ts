import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemeConfig, memeConfigPath, saveMemeConfig } from "../src/config.ts";

const temp = mkdtempSync(join(tmpdir(), "omp-meme-config-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("meme config", () => {
	test("defaults to auto gear and default prompt", () => {
		expect(loadMemeConfig(join(temp, "missing"))).toEqual({ debug: false, gear: "auto", prompt: "" });
	});

	test("round-trips gear, debug and custom prompt", () => {
		saveMemeConfig(temp, { debug: true, gear: "always", prompt: "自定义人设" });
		expect(loadMemeConfig(temp)).toEqual({ debug: true, gear: "always", prompt: "自定义人设" });
		expect(JSON.parse(readFileSync(memeConfigPath(temp), "utf8"))).toEqual({
			debug: true,
			gear: "always",
			prompt: "自定义人设",
		});
		saveMemeConfig(temp, { debug: false, gear: "off", prompt: "" });
		expect(loadMemeConfig(temp)).toEqual({ debug: false, gear: "off", prompt: "" });
	});

	test("falls back to defaults on corrupt config or unknown gear", () => {
		saveMemeConfig(temp, { debug: true, gear: "always", prompt: "x" });
		writeFileSync(memeConfigPath(temp), "{broken");
		expect(loadMemeConfig(temp)).toEqual({ debug: false, gear: "auto", prompt: "" });
		writeFileSync(memeConfigPath(temp), JSON.stringify({ debug: true, gear: "turbo" }));
		expect(loadMemeConfig(temp).gear).toBe("auto");
	});
});
