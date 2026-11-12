import type { MessageRenderer } from "@oh-my-pi/pi-coding-agent";
import { Container, Image, Text } from "@oh-my-pi/pi-tui";
import { basename } from "node:path";
import { loadMemeImage } from "./image.ts";

export const MEME_MESSAGE_TYPE = "omp-meme";

export interface MemeMessageDetails {
	path: string;
	caption: string;
	tag: string;
	pack: string;
	packName: string;
}

function isMemeDetails(value: unknown): value is MemeMessageDetails {
	if (!value || typeof value !== "object") return false;
	const details = value as Partial<MemeMessageDetails>;
	return typeof details.path === "string" && typeof details.caption === "string";
}

export function createMemeRenderer(isDebug: () => boolean): MessageRenderer<MemeMessageDetails> {
	return (message, _options, theme) => {
		const details = message.details;
		if (!isMemeDetails(details)) return undefined;
		const container = new Container();
		if (isDebug()) {
			const label = details.tag ? `[表情: ${details.caption} · ${details.tag}]` : `[表情: ${details.caption}]`;
			container.addChild(new Text(theme.fg("dim", label), 1, 0));
		}
		const image = loadMemeImage(details.path);
		if (!image) {
			container.addChild(new Text(theme.fg("warning", `图片不可读：${details.path}`), 1, 0));
			return container;
		}
		container.addChild(
			new Image(
				image.data,
				image.mimeType,
				{ fallbackColor: text => theme.fg("dim", text) },
				{
					maxWidthCells: 28,
					maxHeightCells: 9,
					filename: basename(details.path),
					sourcePath: details.path,
					imageKey: `${details.path}:${message.timestamp}`,
				},
			),
		);
		return container;
	};
}

export function memeContent(details: MemeMessageDetails): string {
	return `[表情: ${details.caption}]`;
}
