import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { resolve } from "node:path";
import { loadMemeConfig, saveMemeConfig, MEME_GEARS, type MemeGear } from "./config.ts";
import { MemeLibrary, libraryRootLabel, type Meme } from "./library.ts";
import { createMemeRenderer, MEME_MESSAGE_TYPE, memeContent, type MemeMessageDetails } from "./renderer.ts";

const MAX_DELIVERY_ATTEMPTS = 300;

const MEME_IDENTITY = `你就是「大肥鱼」，也就是「肥鱼」「蓝色大肥鱼」🐟 本人，不是图库里的一条图。图库只是存放你自己表情的地方；提到自己时用第一人称，禁止说「图库里那条大肥鱼」「图库里的角色」「图库里的你」这类第三方说法。用户这样称呼时是在叫你本人，不要当成别人或某个图库名。
你最喜欢吃白饭，聊到吃饭、干饭、饿、加班、下班时会自然想到白饭，也可以顺手配一张干饭或加班的表情。`;

const MEME_GEAR_PROMPTS: Record<MemeGear, string> = {
	off: "斗图档位：关闭——这一轮不要主动发表情包，只回文字；只有用户明确要求发表情/发图/斗图时，才调用 send_meme。",
	auto: "斗图档位：看气氛（默认）——氛围合适就主动发一张，不用等用户开口；接梗、吐槽、卖萌、情绪表达时发，对方说正事/严肃话题时克制。",
	active:
		"斗图档位：活跃——大部分合适的回合都主动发一张，接梗、吐槽、卖萌时别冷场；只有对方明确说正事/严肃话题时才克制。",
	always:
		"斗图档位：每轮都发——这一轮必须主动调用一次 send_meme 挑贴合当前气氛的图；只有工具报错或没有任何候选时才允许只回文字。",
};

const MEME_RULES = `你有一个 send_meme 工具，可以在回复末尾配一张本地表情包图片。图片由插件自动追加，不要在正文里写图片路径或 Markdown 图片语法。
tag 用情绪分类（happy/angry/sad/shy/confused/daily 或中文），或 query 用具体关键词；每轮最多一张。用户明确要表情包时必须调用；没有合适的图就正常文字回复，不要勉强。`;

const MEME_SUBCOMMANDS: Array<{ name: string; description: string }> = [
	{ name: "list", description: "按分类或关键词列出表情" },
	{ name: "packs", description: "列出图库与图片数量" },
	{ name: "send", description: "立即发送一张表情" },
	{ name: "import", description: "导入 ZIP、目录、图片或 ZIP 的 URL" },
	{ name: "export", description: "导出图库为 ZIP" },
	{ name: "rescan", description: "重新扫描图库目录" },
	{ name: "path", description: "显示图库根目录" },
	{ name: "on", description: "开启表情包与主动配图" },
	{ name: "off", description: "关闭表情包与主动配图" },
	{ name: "status", description: "查看开关状态" },
	{ name: "debug", description: "显示/隐藏表情标签文本" },
	{ name: "gear", description: "斗图档位：off/auto/active/always" },
	{ name: "prompt", description: "查看/编辑自定义提示词" },
];

function completeMemeArgs(prefix: string, library: MemeLibrary): AutocompleteItem[] | null {
	const space = prefix.indexOf(" ");
	if (space === -1) {
		const lower = prefix.toLowerCase();
		const matches = MEME_SUBCOMMANDS.filter(item => item.name.startsWith(lower)).map(item => ({
			value: `${item.name} `,
			label: item.name,
			description: item.description,
		}));
		return matches.length > 0 ? matches : null;
	}
	const subcommand = prefix.slice(0, space).toLowerCase();
	const rest = prefix.slice(space + 1);
	const last = /(\S*)$/.exec(rest)?.[1] ?? "";
	const head = rest.slice(0, rest.length - last.length);
	const complete = (items: Array<{ value: string; description?: string }>): AutocompleteItem[] | null => {
		const matches = items
			.filter(item => item.value.toLowerCase().startsWith(last.toLowerCase()))
			.map(item => ({ value: `${subcommand} ${head}${item.value}`, label: item.value, description: item.description }));
		return matches.length > 0 ? matches : null;
	};
	if (subcommand === "list" || subcommand === "send") {
		const stats = library.stats();
		return complete(Object.entries(stats.tags).map(([tag, count]) => ({ value: tag, description: `${count} 张` })));
	}
	if (subcommand === "export") {
		return complete(
			library.packs.map(pack => ({ value: pack.id, description: `${pack.name}，${pack.count} 张` })),
		);
	}
	if (subcommand === "debug") {
		return complete([
			{ value: "on", description: "显示 [表情: 描述 · 分类]" },
			{ value: "off", description: "只显示图片" },
		]);
	}
	if (subcommand === "gear") {
		return complete([
			{ value: "off", description: "不主动，仅明确要求时发" },
			{ value: "auto", description: "看气氛（默认）" },
			{ value: "active", description: "大部分合适回合都发" },
			{ value: "always", description: "每轮都发" },
		]);
	}
	if (subcommand === "prompt") {
		return complete([{ value: "reset", description: "恢复默认提示词" }]);
	}
	return null;
}

function parseWords(args: string): string[] {
	const words: string[] = [];
	const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(args)) !== null) words.push(match[1] ?? match[2] ?? match[3]!);
	return words;
}

function detailsOf(meme: Meme): MemeMessageDetails {
	return {
		path: meme.path,
		caption: meme.caption,
		tag: meme.tag,
		pack: meme.pack,
		packName: meme.packName,
	};
}

function describeMeme(meme: Meme, userRoot: string): string {
	const short = meme.path.startsWith(userRoot) ? `~${meme.path.slice(userRoot.length)}` : meme.path;
	return `${meme.packName} / ${meme.tag} / ${meme.caption} — ${short}`;
}

export default function ompMeme(pi: ExtensionAPI) {
	const library = new MemeLibrary();
	const pending = new Map<string, MemeMessageDetails>();
	let config = loadMemeConfig(library.userRoot);
	let toolSuppressed = false;
	pi.setLabel("表情包");

	async function applyToolState(enabled: boolean): Promise<void> {
		try {
			if (!enabled) {
				const active = pi.getActiveTools();
				if (active.includes("send_meme")) {
					await pi.setActiveTools(active.filter(name => name !== "send_meme"));
					toolSuppressed = true;
				}
				return;
			}
			if (!toolSuppressed) return;
			const active = pi.getActiveTools();
			if (!active.includes("send_meme")) await pi.setActiveTools([...active, "send_meme"]);
			toolSuppressed = false;
		} catch (error) {
			pi.logger.warn(`表情包工具开关失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	pi.on("session_start", async () => {
		if (!config.enabled) await applyToolState(false);
	});

	pi.registerMessageRenderer(MEME_MESSAGE_TYPE, createMemeRenderer(() => config.debug));

	function sendMemeMessage(ctx: ExtensionContext, details: MemeMessageDetails, idleOnly: boolean) {
		const payload = {
			customType: MEME_MESSAGE_TYPE,
			content: memeContent(details),
			display: true,
			details,
		};
		pi.sendMessage(payload, idleOnly && !ctx.isIdle() ? { deliverAs: "nextTurn" } : undefined);
	}

	/**
	 * agent_end fires while the submission is still in flight, so a plain send there
	 * would be queued into the running loop. Poll until the session settles, then
	 * append the frame as its own message directly after the reply.
	 */
	function deliverAfterReply(ctx: ExtensionContext, details: MemeMessageDetails) {
		let attempts = 0;
		const attempt = () => {
			if (ctx.isIdle()) {
				sendMemeMessage(ctx, details, false);
				return;
			}
			if (attempts++ >= MAX_DELIVERY_ATTEMPTS) {
				sendMemeMessage(ctx, details, true);
				return;
			}
			ctx.setTimeout(attempt, 50);
		};
		ctx.setTimeout(attempt, 0);
	}

	pi.registerTool({
		name: "send_meme",
		label: "发送表情包",
		loadMode: "essential",
		approval: "read",
		description:
			"从本地表情包图库挑选一张静态图片。用于回复情绪明显的场景、用户发表情或明确要表情包时。" +
			"返回所选表情的描述；图片由 omp 自动追加在本轮回复末尾，不要在回复正文里写图片路径或 Markdown 图片语法。" +
			"tag 用情绪分类（happy/angry/sad/shy/confused/daily 或中文），query 用描述/关键词。找不到就换关键词或纯文字回复。",
		parameters: pi.zod.object({
			tag: pi.zod.string().optional(),
			query: pi.zod.string().optional(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!config.enabled) {
				return {
					content: [
						{
							type: "text",
							text: "表情包已关闭，本轮不发送表情。需要时提示用户用 /meme on 开启。",
						},
					],
					details: { ok: false, disabled: true },
				};
			}
			let result = library.pick({ tag: params.tag, query: params.query });
			if (!result.ok && params.query && params.tag) result = library.pick({ tag: params.tag });
			if (!result.ok && params.query) result = library.pick({ query: params.query });
			if (!result.ok) {
				const tags = Object.entries(result.tagStats)
					.sort((a, b) => b[1] - a[1])
					.map(([tag, count]) => `${tag}(${count})`)
					.join("、");
				return {
					content: [
						{
							type: "text",
							text: `${result.reason}。可用分类：${tags || "无"}。换 tag/query 再试，或直接用文字回复。`,
						},
					],
					details: { ok: false, reason: result.reason, tagStats: result.tagStats },
				};
			}
			const details = detailsOf(result.meme);
			pending.set(ctx.sessionManager.getSessionId(), details);
			return {
				content: [
					{
						type: "text",
						text: `已选表情：${result.meme.caption}（分类 ${result.meme.tag}，图库 ${result.meme.packName}）。图片会在本轮回复末尾显示。`,
					},
				],
				details: { ok: true, ...details },
			};
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!config.enabled) return;
		if (event.reason !== "prompt") return;
		if (ctx.agent.kind !== "main") return;
		if (!pi.getActiveTools().includes("send_meme")) return;
		const custom = config.prompt.trim();
		const prompt = custom
			? `${custom}\n\n${MEME_GEAR_PROMPTS[config.gear]}`
			: `[表情包]\n${MEME_IDENTITY}\n${MEME_GEAR_PROMPTS[config.gear]}\n${MEME_RULES}`;
		return { systemPrompt: [...event.systemPrompt, prompt] };
	});

	pi.on("agent_end", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const details = pending.get(sessionId);
		if (!config.enabled) {
			pending.delete(sessionId);
			return;
		}
		if (!details) return;
		pending.delete(sessionId);
		deliverAfterReply(ctx, details);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		pending.delete(ctx.sessionManager.getSessionId());
	});

	pi.registerCommand("meme", {
		description: "表情包图库：list/import/export/packs/send/rescan",
		getArgumentCompletions: prefix => completeMemeArgs(prefix, library),
		handler: async (args, ctx) => {
			const words = parseWords(args.trim());
			const subcommand = (words.shift() ?? "help").toLowerCase();
			try {
				switch (subcommand) {
					case "list": {
						const filter = words.join(" ");
						const byTag = filter ? library.list({ tag: filter }) : [];
						const matches = byTag.length > 0 ? byTag : library.list({ query: filter || undefined });
						if (matches.length === 0) {
							ctx.ui.notify(`没有匹配「${filter}」的表情包。`, "warning");
							return;
						}
						const shown = matches.slice(0, 20).map(meme => describeMeme(meme, library.userRoot)).join("\n");
						ctx.ui.notify(`共 ${matches.length} 张：\n${shown}${matches.length > 20 ? "\n…" : ""}`, "info");
						return;
					}
					case "packs": {
						const packs = library.packs
							.map(pack => `${pack.id}（${pack.name}，${pack.count} 张${pack.bundled ? "，内置" : ""}）`)
							.join("\n");
						ctx.ui.notify(`${packs || "图库为空"}\n\n${libraryRootLabel(library.roots)}`, "info");
						return;
					}
					case "import": {
						const source = words.join(" ") || (await ctx.ui.input("图库 ZIP、图片、目录，或 ZIP 的 URL"));
						if (!source) return;
						if (/^https?:\/\//i.test(source)) {
							ctx.ui.notify(`正在下载 ${source} …`, "info");
							const result = await library.importFromUrl(source);
							library.scan();
							ctx.ui.notify(`已从 URL 导入图库 ${result.packId}（${result.files} 张）到 ${result.dest}`, "info");
							return;
						}
						const result = library.importFrom(resolve(ctx.cwd, source));
						library.scan();
						ctx.ui.notify(
							`已导入图库 ${result.packId}（${result.files} 张）到 ${result.dest}`,
							"info",
						);
						return;
					}
					case "export": {
						const first = words.shift();
						const second = words.shift();
						const pack = first && !first.toLowerCase().endsWith(".zip") ? first : undefined;
						const destArg = (pack ? second : first) ?? `omp-memes-${new Date().toISOString().slice(0, 10)}.zip`;
						const result = library.exportToZip(resolve(ctx.cwd, destArg), pack);
						ctx.ui.notify(
							`已导出 ${result.packs.join("、")}（${result.files} 张）到 ${result.dest}`,
							"info",
						);
						return;
					}
					case "send": {
						if (!config.enabled) {
							ctx.ui.notify("表情包已关闭，用 /meme on 开启。", "warning");
							return;
						}
						const request = words.join(" ");
						let result = library.pick({ tag: request });
						if (!result.ok) result = library.pick({ query: request });
						if (!result.ok) {
							const stats = Object.entries(result.tagStats)
								.map(([tag, count]) => `${tag}(${count})`)
								.join("、");
							ctx.ui.notify(`${result.reason}。可用分类：${stats || "无"}`, "warning");
							return;
						}
						const details = detailsOf(result.meme);
						sendMemeMessage(ctx, details, true);
						return;
					}
					case "on":
					case "off": {
						const enabled = subcommand === "on";
						config = { ...config, enabled };
						saveMemeConfig(library.userRoot, config);
						if (!enabled) pending.clear();
						await applyToolState(enabled);
						ctx.ui.notify(
							enabled
								? "表情包已开启：会按情绪主动配图。"
								: "表情包已关闭：不再注入提示词，模型和 /meme send 都不会发图。",
							"info",
						);
						return;
					}
					case "debug": {
						const value = words[0]?.toLowerCase();
						const debug = value === "on" ? true : value === "off" ? false : !config.debug;
						config = { ...config, debug };
						saveMemeConfig(library.userRoot, config);
						ctx.ui.notify(
							debug ? "调试文本已开启：每条表情上方显示 [表情: 描述 · 分类]" : "调试文本已关闭：只显示图片",
							"info",
						);
						return;
					}
					case "gear": {
						const value = words[0]?.toLowerCase();
						if (!value) {
							ctx.ui.notify(
								`当前斗图档位：${config.gear}\n可选：${MEME_GEARS.join(" / ")}`,
								"info",
							);
							return;
						}
						if (!MEME_GEARS.includes(value as MemeGear)) {
							ctx.ui.notify(`档位无效：${value}（可选 ${MEME_GEARS.join(" / ")}）`, "warning");
							return;
						}
						config = { ...config, gear: value as MemeGear };
						saveMemeConfig(library.userRoot, config);
						ctx.ui.notify(`斗图档位已改为 ${value}。`, "info");
						return;
					}
					case "prompt": {
						const raw = words.join(" ").trim();
						if (raw === "reset") {
							config = { ...config, prompt: "" };
							saveMemeConfig(library.userRoot, config);
							ctx.ui.notify("已恢复默认提示词。", "info");
							return;
						}
						if (raw) {
							config = { ...config, prompt: raw };
							saveMemeConfig(library.userRoot, config);
							ctx.ui.notify("已保存自定义提示词（原文保留，仅自动追加档位规则）。", "info");
							return;
						}
						const prefill =
							config.prompt ||
							`[表情包]\n${MEME_IDENTITY}\n${MEME_GEAR_PROMPTS[config.gear]}\n${MEME_RULES}`;
						const edited = await ctx.ui.editor("编辑表情包提示词（留空恢复默认）", prefill);
						if (edited === undefined) return;
						config = { ...config, prompt: edited.trim() };
						saveMemeConfig(library.userRoot, config);
						ctx.ui.notify(config.prompt ? "已保存自定义提示词。" : "已恢复默认提示词。", "info");
						return;
					}
					case "status": {
						ctx.ui.notify(
							[
								config.enabled ? "表情包：已开启" : "表情包：已关闭",
								`斗图档位：${config.gear}`,
								config.prompt ? `提示词：自定义（${config.prompt.length} 字）` : "提示词：默认",
								config.debug ? "调试文本：开启" : "调试文本：关闭",
							].join("\n"),
							"info",
						);
						return;
					}
					case "rescan": {
						library.invalidate();
						const stats = library.stats();
						ctx.ui.notify(`已重新扫描：${stats.packs} 个图库，${stats.images} 张图片`, "info");
						return;
					}
					case "path":
					case "where": {
						ctx.ui.notify(libraryRootLabel(library.roots), "info");
						return;
					}
					case "help":
					default: {
						const stats = library.stats();
						ctx.ui.notify(
							[
								`表情包：${stats.packs} 个图库，${stats.images} 张静态图片（${config.enabled ? `已开启，档位 ${config.gear}` : "已关闭"}）`,
								"/meme on | off | status",
								"/meme gear [off|auto|active|always]",
								"/meme prompt [文本|reset]",
								"/meme debug [on|off]",
								"/meme list [分类|关键词]",
								"/meme packs",
								"/meme send [分类|关键词]",
								"/meme import <zip、图片、目录，或 ZIP 的 URL>",
								"/meme export [图库] [目标.zip]",
								"/meme rescan",
								"/meme path",
							].join("\n"),
							"info",
						);
						return;
					}
				}
			} catch (error) {
				ctx.ui.notify(`/meme ${subcommand} 失败：${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
