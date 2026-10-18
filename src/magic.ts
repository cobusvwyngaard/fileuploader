// File signature ("magic number") checks. Only the first few bytes of an
// uploaded file are ever read, to confirm the content matches its extension.

const SIGNATURES: { exts: string[]; test: (b: Uint8Array) => boolean; mime: string }[] = [
  { exts: ['pdf'], mime: 'application/pdf', test: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]) },
  { exts: ['png'], mime: 'image/png', test: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { exts: ['jpg', 'jpeg'], mime: 'image/jpeg', test: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  { exts: ['gif'], mime: 'image/gif', test: (b) => ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a' },
  { exts: ['webp'], mime: 'image/webp', test: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP' },
  { exts: ['tif', 'tiff'], mime: 'image/tiff', test: (b) => startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a]) },
  {
    exts: ['heic', 'heif'],
    mime: 'image/heic',
    test: (b) => ascii(b, 4, 4) === 'ftyp' && ['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(ascii(b, 8, 4)),
  },
  { exts: ['mp4', 'mov', 'm4a'], mime: 'video/mp4', test: (b) => ascii(b, 4, 4) === 'ftyp' || ascii(b, 4, 4) === 'moov' || ascii(b, 4, 4) === 'wide' || ascii(b, 4, 4) === 'mdat' },
  // OOXML documents and zip archives share the zip local-file-header signature.
  { exts: ['zip', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'], mime: 'application/zip', test: (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06]) },
  // Legacy Office (OLE compound file).
  { exts: ['doc', 'xls', 'ppt', 'msg'], mime: 'application/x-ole-storage', test: (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) },
  { exts: ['mp3'], mime: 'audio/mpeg', test: (b) => ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0) },
];

function startsWith(b: Uint8Array, sig: number[]): boolean {
  return sig.every((v, i) => b[i] === v);
}

function ascii(b: Uint8Array, offset: number, len: number): string {
  return String.fromCharCode(...b.slice(offset, offset + len));
}

const TEXT_EXTS = new Set(['txt', 'csv', 'tsv', 'json', 'xml', 'md', 'log']);

/** Bytes that executable formats start with. Rejected whatever the extension. */
function looksExecutable(b: Uint8Array): boolean {
  return (
    startsWith(b, [0x4d, 0x5a]) || // Windows PE ("MZ")
    startsWith(b, [0x7f, 0x45, 0x4c, 0x46]) || // ELF
    startsWith(b, [0xcf, 0xfa, 0xed, 0xfe]) || // Mach-O
    startsWith(b, [0xca, 0xfe, 0xba, 0xbe])
  );
}

export type ContentCheck = 'match' | 'mismatch' | 'unchecked';

/**
 * Compares the leading bytes with what the extension promises. Extensions with
 * no known signature are 'unchecked' unless the bytes look executable.
 */
export function checkContent(ext: string, header: Uint8Array): ContentCheck {
  if (looksExecutable(header)) return 'mismatch';
  const sigs = SIGNATURES.filter((s) => s.exts.includes(ext));
  if (sigs.length) return sigs.some((s) => s.test(header)) ? 'match' : 'mismatch';
  if (TEXT_EXTS.has(ext)) {
    // Text files must not contain NUL bytes in their first bytes (binary disguised as text).
    return header.includes(0) && !(header[0] === 0xff && header[1] === 0xfe) && !(header[0] === 0xfe && header[1] === 0xff) ? 'mismatch' : 'match';
  }
  return 'unchecked';
}

export function detectMime(header: Uint8Array): string | null {
  return SIGNATURES.find((s) => s.test(header))?.mime ?? null;
}
