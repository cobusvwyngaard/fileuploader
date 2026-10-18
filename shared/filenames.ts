import { MAX_ORIGINAL_FILENAME_LENGTH } from './constants';

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
// Characters OneDrive/SharePoint reject, plus characters that are awkward in URLs and shells.
const UNSAFE_CHARS = /["*:<>?/\\|#%&{}~$!'`^+=;,@[\]()]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const MAX_BASE_LENGTH = 80;

/** Removes any directory component a browser (or attacker) included in the name. */
export function stripPath(name: string): string {
  const parts = name.split(/[/\\]/);
  return parts[parts.length - 1] ?? '';
}

/** Returns the lower-case extension without the dot, or '' if there is none. */
export function getExtension(name: string): string {
  const base = stripPath(name).trim();
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  const ext = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

/** Normalises a user-supplied extension list entry (".PDF" -> "pdf"). */
export function normaliseExtension(ext: string): string {
  return ext.trim().replace(/^\.+/, '').toLowerCase();
}

/**
 * Cleans an original filename for display and storage in D1/Excel. This value is
 * never used as a OneDrive path; see {@link buildStoredFilename}.
 */
export function cleanOriginalFilename(name: string): string {
  const cleaned = stripPath(name.normalize('NFC')).replace(CONTROL_CHARS, '').trim();
  return cleaned.slice(0, MAX_ORIGINAL_FILENAME_LENGTH) || 'file';
}

/** Produces a safe base name (no extension) using a conservative character set. */
export function sanitiseBaseName(name: string): string {
  let base = stripPath(name.normalize('NFKC'));
  const ext = getExtension(base);
  if (ext) base = base.slice(0, base.length - ext.length - 1);
  base = base
    .replace(CONTROL_CHARS, '')
    .replace(UNSAFE_CHARS, '_')
    .replace(/\.+/g, '_') // no dots left in the base: blocks "invoice.pdf.exe" games and ".." segments
    .replace(/\s+/g, '_')
    .replace(/_vti_/gi, '_')
    .replace(/_+/g, '_')
    .replace(/^[_\-\s]+|[_\-\s]+$/g, '');
  base = Array.from(base).slice(0, MAX_BASE_LENGTH).join('').replace(/[_-]+$/, '');
  if (!base) return 'file';
  if (WINDOWS_RESERVED.test(base)) return `file_${base}`;
  return base;
}

/**
 * The name used in OneDrive. It is fully server-determined: a date, the
 * submission reference and file index make it unique, so uploads never collide
 * and the Worker can find the file again by path without trusting the browser.
 */
export function buildStoredFilename(params: {
  originalName: string;
  reference: string;
  index: number;
  createdAt: Date;
}): string {
  const ext = getExtension(params.originalName);
  if (!ext) throw new Error('File has no valid extension');
  const date = params.createdAt.toISOString().slice(0, 10).replace(/-/g, '');
  const idx = String(params.index + 1).padStart(2, '0');
  const ref = params.reference.replace(/[^A-Z0-9-]/gi, '');
  return `${date}_${ref}_${idx}_${sanitiseBaseName(params.originalName)}.${ext}`;
}

/** Joins a display folder path and file name without allowing traversal. */
export function joinDrivePath(folderPath: string, fileName: string): string {
  if (fileName.includes('/') || fileName.includes('\\') || fileName === '.' || fileName === '..') {
    throw new Error('Invalid file name');
  }
  const trimmed = folderPath.replace(/\/+$/, '');
  return `${trimmed || ''}/${fileName}`;
}
