import { inflateRawSync } from 'node:zlib';

/** Minimal RFC4180-ish CSV parser with quoted fields and CRLF/BOM support. */
export function parseCsv(text: string): string[][] {
  const input = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
}

function readUInt32(buf: Buffer, offset: number): number {
  return buf.readUInt32LE(offset);
}

interface ZipEntry { name: string; method: number; compressedSize: number; localOffset: number; }

function zipEntries(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (readUInt32(buf, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('xlsx: end of central directory not found');
  const count = buf.readUInt16LE(eocd + 10);
  const centralOffset = readUInt32(buf, eocd + 16);
  const entries: ZipEntry[] = [];
  let p = centralOffset;
  for (let i = 0; i < count; i += 1) {
    if (readUInt32(buf, p) !== 0x02014b50) throw new Error('xlsx: bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = readUInt32(buf, p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = readUInt32(buf, p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function zipFile(buf: Buffer, entry: ZipEntry): Buffer {
  const p = entry.localOffset;
  if (readUInt32(buf, p) !== 0x04034b50) throw new Error('xlsx: bad local file header');
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);
  return entry.method === 8 ? inflateRawSync(raw) : raw;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function textOf(xml: string): string {
  return decodeXml(xml.replace(/<[^>]+>/g, ''));
}

function colIndex(ref: string): number {
  const letters = ref.replace(/[^A-Z]/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Read the first worksheet from a basic OOXML xlsx file. Strings/numbers only. */
export function parseXlsx(buf: Buffer): string[][] {
  const entries = zipEntries(buf);
  const get = (name: string) => {
    const entry = entries.find((e) => e.name === name);
    return entry ? zipFile(buf, entry) : null;
  };
  const sharedXml = get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  const shared: string[] = [];
  for (const m of sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));
  const sheetName = entries.find((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))?.name;
  if (!sheetName) throw new Error('xlsx: worksheet not found');
  const sheetXml = zipFile(buf, entries.find((e) => e.name === sheetName)!).toString('utf8');
  const rows: string[][] = [];
  for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2];
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /t="([^"]+)"/.exec(attrs)?.[1];
      let value = '';
      if (type === 'inlineStr') value = textOf(body);
      else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
        value = type === 's' ? (shared[Number(v)] ?? '') : decodeXml(v);
      }
      if (ref) cells[colIndex(ref)] = value;
    }
    if (cells.some((v) => v !== undefined && String(v).trim() !== '')) rows.push(cells.map((v) => v ?? ''));
  }
  return rows;
}
