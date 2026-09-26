// Minimal ZIP reader (stored + deflate entries), enough to read Forge's
// cardsfolder.zip without adding a dependency.

import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  read(): Buffer;
}

export function readZip(path: string): ZipEntry[] {
  const buf = readFileSync(path);

  // The "end of central directory" record sits in the last 64 KiB of the file.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error(`${path} is not a zip file`);

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('Corrupt zip central directory');
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localHeader = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    entries.push({
      name,
      read() {
        const localNameLength = buf.readUInt16LE(localHeader + 26);
        const localExtraLength = buf.readUInt16LE(localHeader + 28);
        const start = localHeader + 30 + localNameLength + localExtraLength;
        const data = buf.subarray(start, start + compressedSize);
        return method === 0 ? data : inflateRawSync(data);
      },
    });
  }
  return entries;
}
