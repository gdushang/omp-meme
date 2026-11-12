import { deflateRawSync, inflateRawSync } from "node:zlib";

export interface ZipEntry {
	name: string;
	data: Uint8Array;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800;
const MAX_EOCD_SEARCH = 0xffff + 22;

let crcTable: Uint32Array | undefined;

function crc32(data: Uint8Array): number {
	let table = crcTable;
	if (!table) {
		table = new Uint32Array(256);
		for (let i = 0; i < 256; i++) {
			let c = i;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			table[i] = c >>> 0;
		}
		crcTable = table;
	}
	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
	const year = Math.max(1980, date.getFullYear());
	return {
		time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
		date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
	};
}

/** Build a ZIP archive. Entries are stored deflated when that is smaller. */
export function writeZip(entries: ZipEntry[], date = new Date()): Buffer {
	const { time, date: dosDate } = dosDateTime(date);
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	const encoder = new TextEncoder();

	for (const entry of entries) {
		const nameBytes = encoder.encode(entry.name.replaceAll("\\", "/"));
		const raw = Buffer.from(entry.data);
		const crc = crc32(raw);
		const deflated = deflateRawSync(raw);
		const useDeflate = deflated.length < raw.length;
		const payload = useDeflate ? deflated : raw;
		const method = useDeflate ? 8 : 0;

		const local = Buffer.alloc(30);
		local.writeUInt32LE(LOCAL_SIG, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(UTF8_FLAG, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(time, 10);
		local.writeUInt16LE(dosDate, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(payload.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		local.writeUInt16LE(0, 28);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(CENTRAL_SIG, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(UTF8_FLAG, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt16LE(time, 12);
		central.writeUInt16LE(dosDate, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(payload.length, 20);
		central.writeUInt32LE(raw.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt16LE(0, 30);
		central.writeUInt16LE(0, 32);
		central.writeUInt16LE(0, 34);
		central.writeUInt16LE(0, 36);
		central.writeUInt32LE(0, 38);
		central.writeUInt32LE(offset, 42);

		locals.push(local, Buffer.from(nameBytes), payload);
		centrals.push(central, Buffer.from(nameBytes));
		offset += 30 + nameBytes.length + payload.length;
	}

	const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(EOCD_SIG, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralSize, 12);
	eocd.writeUInt32LE(offset, 16);
	eocd.writeUInt16LE(0, 20);

	return Buffer.concat([...locals, ...centrals, eocd]);
}

/** Read a ZIP archive. Directory entries are skipped; ZIP64 is rejected. */
export function readZip(input: Uint8Array): ZipEntry[] {
	const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
	const start = Math.max(0, buf.length - MAX_EOCD_SEARCH);
	let eocd = -1;
	for (let i = buf.length - 22; i >= start; i--) {
		if (buf.readUInt32LE(i) === EOCD_SIG) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error("不是有效的 ZIP 文件（找不到目录结尾）");

	const total = buf.readUInt16LE(eocd + 10);
	const centralOffset = buf.readUInt32LE(eocd + 16);
	if (centralOffset === 0xffffffff || total === 0xffff) throw new Error("暂不支持 ZIP64 文件");

	const entries: ZipEntry[] = [];
	const decoder = new TextDecoder();
	let at = centralOffset;
	for (let i = 0; i < total; i++) {
		if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL_SIG) {
			throw new Error("ZIP 目录损坏");
		}
		const flags = buf.readUInt16LE(at + 8);
		const method = buf.readUInt16LE(at + 10);
		const compressedSize = buf.readUInt32LE(at + 20);
		const nameLength = buf.readUInt16LE(at + 28);
		const extraLength = buf.readUInt16LE(at + 30);
		const commentLength = buf.readUInt16LE(at + 32);
		const localOffset = buf.readUInt32LE(at + 42);
		const name = decoder.decode(buf.subarray(at + 46, at + 46 + nameLength));

		if (name.endsWith("/") || name.endsWith("\\")) {
			at += 46 + nameLength + extraLength + commentLength;
			continue;
		}
		if (flags & 0x0001) throw new Error(`不支持加密条目：${name}`);
		if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
			throw new Error(`ZIP 条目损坏：${name}`);
		}
		const localNameLength = buf.readUInt16LE(localOffset + 26);
		const localExtraLength = buf.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		const payload = buf.subarray(dataStart, dataStart + compressedSize);

		let data: Uint8Array;
		if (method === 0) data = new Uint8Array(payload);
		else if (method === 8) data = inflateRawSync(payload);
		else throw new Error(`不支持的压缩方式 ${method}：${name}`);
		entries.push({ name, data });
		at += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}
