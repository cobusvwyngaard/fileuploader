// Validation shared by the browser (for fast feedback) and the Worker (authoritative).
import {
  BLOCKED_EXTENSIONS,
  HARD_MAX_FILES_PER_SUBMISSION,
  HARD_MAX_FILE_SIZE_BYTES,
  MAX_FIELDS,
  MAX_FIELD_VALUE_LENGTH,
  MAX_INSTRUCTIONS_LENGTH,
  MAX_OPTIONS,
  MAX_SHORT_FIELD_LENGTH,
  MAX_TITLE_LENGTH,
  STANDARD_EXCEL_COLUMNS,
} from './constants';
import { getExtension, normaliseExtension, stripPath } from './filenames';
import {
  FIELD_TYPES,
  type DeclaredFile,
  type FieldDefinition,
  type FileRules,
  type SessionConfigInput,
} from './types';

export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
const NUMBER_PATTERN = /^-?\d{1,15}(\.\d{1,6})?$/;

export type FieldValues = Record<string, string | number>;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function excelColumnFor(field: Pick<FieldDefinition, 'key' | 'excelColumn'>): string {
  return (field.excelColumn?.trim() || field.key).trim();
}

/** Validates the admin-defined form fields. Returns a list of human readable errors. */
export function validateFieldDefinitions(fields: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(fields)) return ['Fields must be a list.'];
  if (fields.length > MAX_FIELDS) errors.push(`At most ${MAX_FIELDS} fields are allowed.`);
  const keys = new Set<string>();
  const columns = new Set<string>(STANDARD_EXCEL_COLUMNS.map((c) => c.toLowerCase()));
  fields.forEach((raw, i) => {
    const where = `Field ${i + 1}`;
    if (!isPlainObject(raw)) {
      errors.push(`${where} is invalid.`);
      return;
    }
    const f = raw as Partial<FieldDefinition>;
    if (typeof f.label !== 'string' || !f.label.trim() || f.label.length > MAX_SHORT_FIELD_LENGTH) {
      errors.push(`${where}: label is required (max ${MAX_SHORT_FIELD_LENGTH} characters).`);
    }
    if (typeof f.key !== 'string' || !FIELD_KEY_PATTERN.test(f.key)) {
      errors.push(`${where}: key must start with a letter and contain only lower-case letters, digits and underscores (max 40).`);
    } else if (keys.has(f.key)) {
      errors.push(`${where}: key "${f.key}" is used more than once.`);
    } else {
      keys.add(f.key);
    }
    if (!FIELD_TYPES.includes(f.type as never)) errors.push(`${where}: unknown type.`);
    if (typeof f.required !== 'boolean') errors.push(`${where}: required must be true or false.`);
    if (f.type === 'select') {
      const opts = f.options;
      if (!Array.isArray(opts) || opts.length === 0) {
        errors.push(`${where}: dropdown fields need at least one option.`);
      } else {
        if (opts.length > MAX_OPTIONS) errors.push(`${where}: at most ${MAX_OPTIONS} options.`);
        const seen = new Set<string>();
        for (const o of opts) {
          if (typeof o !== 'string' || !o.trim() || o.length > MAX_SHORT_FIELD_LENGTH) {
            errors.push(`${where}: options must be non-empty text.`);
            break;
          }
          if (seen.has(o.trim())) {
            errors.push(`${where}: option "${o}" is duplicated.`);
            break;
          }
          seen.add(o.trim());
        }
      }
    } else if (f.options !== undefined && (!Array.isArray(f.options) || f.options.length > 0)) {
      errors.push(`${where}: only dropdown fields can have options.`);
    }
    if (f.excelColumn !== undefined && (typeof f.excelColumn !== 'string' || f.excelColumn.length > 255)) {
      errors.push(`${where}: Excel column must be text (max 255 characters).`);
    }
    if (f.helpText !== undefined && (typeof f.helpText !== 'string' || f.helpText.length > 500)) {
      errors.push(`${where}: help text must be at most 500 characters.`);
    }
    if (typeof f.key === 'string') {
      const col = excelColumnFor(f as FieldDefinition).toLowerCase();
      if (columns.has(col)) {
        errors.push(`${where}: Excel column "${excelColumnFor(f as FieldDefinition)}" clashes with a standard or other field column.`);
      }
      columns.add(col);
    }
  });
  return errors;
}

export function validateFileRules(rules: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(rules)) return ['File rules are required.'];
  const r = rules as Partial<FileRules>;
  if (!Array.isArray(r.allowedExtensions) || r.allowedExtensions.length === 0) {
    errors.push('List at least one allowed file extension.');
  } else {
    for (const raw of r.allowedExtensions) {
      const ext = typeof raw === 'string' ? normaliseExtension(raw) : '';
      if (!/^[a-z0-9]{1,10}$/.test(ext)) errors.push(`"${String(raw)}" is not a valid extension.`);
      else if (BLOCKED_EXTENSIONS.has(ext)) errors.push(`".${ext}" files are blocked for security reasons.`);
    }
  }
  if (!Number.isInteger(r.maxFileSizeBytes) || (r.maxFileSizeBytes as number) < 1 || (r.maxFileSizeBytes as number) > HARD_MAX_FILE_SIZE_BYTES) {
    errors.push('Maximum file size must be between 1 byte and 250 GB.');
  }
  if (!Number.isInteger(r.maxFilesPerSubmission) || (r.maxFilesPerSubmission as number) < 1 || (r.maxFilesPerSubmission as number) > HARD_MAX_FILES_PER_SUBMISSION) {
    errors.push(`Maximum files per submission must be between 1 and ${HARD_MAX_FILES_PER_SUBMISSION}.`);
  }
  return errors;
}

/**
 * Validates and normalises a session configuration. `forPublish` adds the
 * requirements that only apply to a live session (folder and future expiry).
 */
export function validateSessionConfig(
  input: unknown,
  opts: { forPublish: boolean; now: Date },
): { value?: SessionConfigInput; errors: string[] } {
  if (!isPlainObject(input)) return { errors: ['Invalid session configuration.'] };
  const errors: string[] = [];
  const i = input as Partial<SessionConfigInput>;
  const title = typeof i.title === 'string' ? i.title.trim() : '';
  if (!title || title.length > MAX_TITLE_LENGTH) errors.push(`Title is required (max ${MAX_TITLE_LENGTH} characters).`);
  const instructions = typeof i.instructions === 'string' ? i.instructions.trim() : '';
  if (instructions.length > MAX_INSTRUCTIONS_LENGTH) errors.push(`Instructions must be at most ${MAX_INSTRUCTIONS_LENGTH} characters.`);

  let folder: SessionConfigInput['folder'] = null;
  if (i.folder != null) {
    const f = i.folder as unknown as Record<string, unknown>;
    if (!isPlainObject(f) || typeof f.driveId !== 'string' || typeof f.itemId !== 'string' || typeof f.path !== 'string' || !f.driveId || !f.itemId) {
      errors.push('Destination folder is invalid.');
    } else {
      folder = { driveId: f.driveId, itemId: f.itemId, path: f.path, webUrl: typeof f.webUrl === 'string' ? f.webUrl : undefined };
    }
  }
  if (opts.forPublish && !folder) errors.push('Choose a OneDrive destination folder.');

  let expiresAt: string | null = null;
  if (i.expiresAt != null) {
    const d = typeof i.expiresAt === 'string' ? new Date(i.expiresAt) : new Date(NaN);
    if (Number.isNaN(d.getTime())) errors.push('Expiry date is invalid.');
    else expiresAt = d.toISOString();
  }
  if (opts.forPublish) {
    if (!expiresAt) errors.push('Set an expiry date and time.');
    else if (new Date(expiresAt).getTime() <= opts.now.getTime()) errors.push('Expiry must be in the future.');
  }

  let maxSubmissions: number | null = null;
  if (i.maxSubmissions != null) {
    if (!Number.isInteger(i.maxSubmissions) || (i.maxSubmissions as number) < 1 || (i.maxSubmissions as number) > 1_000_000) {
      errors.push('Maximum submissions must be a whole number of at least 1, or empty for unlimited.');
    } else maxSubmissions = i.maxSubmissions as number;
  }

  errors.push(...validateFileRules(i.fileRules));
  errors.push(...validateFieldDefinitions(i.fields));
  if (i.showOneDriveLinks !== undefined && typeof i.showOneDriveLinks !== 'boolean') errors.push('showOneDriveLinks must be true or false.');
  if (errors.length) return { errors };

  const rules = i.fileRules as FileRules;
  const fields = (i.fields as FieldDefinition[]).map((f) => {
    const clean: FieldDefinition = { label: f.label.trim(), key: f.key, type: f.type, required: f.required };
    if (f.type === 'select') clean.options = (f.options ?? []).map((o) => o.trim());
    if (f.excelColumn?.trim() && f.excelColumn.trim() !== f.key) clean.excelColumn = f.excelColumn.trim();
    if (f.helpText?.trim()) clean.helpText = f.helpText.trim();
    return clean;
  });
  return {
    errors: [],
    value: {
      title,
      instructions,
      folder,
      expiresAt,
      maxSubmissions,
      fileRules: {
        allowedExtensions: [...new Set(rules.allowedExtensions.map(normaliseExtension))],
        maxFileSizeBytes: rules.maxFileSizeBytes,
        maxFilesPerSubmission: rules.maxFilesPerSubmission,
      },
      fields,
      showOneDriveLinks: i.showOneDriveLinks === true,
    },
  };
}

/**
 * Validates submitted form values against the session's field definitions.
 * Unknown keys are rejected, strings are trimmed, numbers are parsed.
 */
export function validateFieldValues(
  fields: Pick<FieldDefinition, 'key' | 'label' | 'type' | 'required' | 'options'>[],
  input: unknown,
): { values: FieldValues; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const values: FieldValues = {};
  if (!isPlainObject(input)) return { values, errors: { _form: 'Form values are missing.' } };
  const known = new Set(fields.map((f) => f.key));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) errors[key] = 'Unexpected field.';
  }
  for (const f of fields) {
    const raw = input[f.key];
    if (raw !== undefined && raw !== null && typeof raw !== 'string' && typeof raw !== 'number') {
      errors[f.key] = `${f.label} is invalid.`;
      continue;
    }
    const str = raw === undefined || raw === null ? '' : String(raw).trim();
    if (!str) {
      if (f.required) errors[f.key] = `${f.label} is required.`;
      continue;
    }
    const limit = f.type === 'textarea' ? MAX_FIELD_VALUE_LENGTH : MAX_SHORT_FIELD_LENGTH;
    if (str.length > limit) {
      errors[f.key] = `${f.label} must be at most ${limit} characters.`;
      continue;
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(str)) {
      errors[f.key] = `${f.label} contains invalid characters.`;
      continue;
    }
    switch (f.type) {
      case 'email':
        if (!EMAIL_PATTERN.test(str) || str.length > 254) errors[f.key] = `${f.label} must be a valid email address.`;
        else values[f.key] = str;
        break;
      case 'number':
        if (!NUMBER_PATTERN.test(str)) errors[f.key] = `${f.label} must be a number.`;
        else values[f.key] = Number(str);
        break;
      case 'select':
        if (!(f.options ?? []).includes(str)) errors[f.key] = `Choose a valid option for ${f.label}.`;
        else values[f.key] = str;
        break;
      default:
        values[f.key] = str;
    }
  }
  return { values, errors };
}

/** Expected MIME types per extension. Used to reject obviously mismatched declarations. */
export const EXTENSION_MIME_TYPES: Record<string, string[]> = {
  pdf: ['application/pdf'],
  png: ['image/png'],
  jpg: ['image/jpeg', 'image/pjpeg'],
  jpeg: ['image/jpeg', 'image/pjpeg'],
  gif: ['image/gif'],
  webp: ['image/webp'],
  heic: ['image/heic', 'image/heif'],
  heif: ['image/heif', 'image/heic'],
  tif: ['image/tiff'],
  tiff: ['image/tiff'],
  txt: ['text/plain'],
  csv: ['text/csv', 'application/vnd.ms-excel', 'text/plain', 'application/csv'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/zip'],
  doc: ['application/msword'],
  xls: ['application/vnd.ms-excel'],
  ppt: ['application/vnd.ms-powerpoint'],
  zip: ['application/zip', 'application/x-zip-compressed', 'application/x-zip'],
  mp4: ['video/mp4'],
  mov: ['video/quicktime'],
  mp3: ['audio/mpeg', 'audio/mp3'],
};

export function declaredTypeMatchesExtension(ext: string, declaredType: string): boolean {
  const type = declaredType.split(';')[0]!.trim().toLowerCase();
  // Browsers leave the type empty or generic when they do not recognise a file.
  if (!type || type === 'application/octet-stream') return true;
  const expected = EXTENSION_MIME_TYPES[ext];
  return !expected || expected.includes(type);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 10 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/** Validates the files a visitor intends to upload. Returns per-file and overall errors. */
export function validateDeclaredFiles(
  rules: FileRules,
  files: unknown,
): { errors: string[]; files: DeclaredFile[] } {
  const errors: string[] = [];
  if (!Array.isArray(files) || files.length === 0) return { errors: ['Select at least one file.'], files: [] };
  if (files.length > rules.maxFilesPerSubmission) {
    errors.push(
      rules.maxFilesPerSubmission === 1
        ? 'Only one file can be uploaded.'
        : `At most ${rules.maxFilesPerSubmission} files can be uploaded.`,
    );
  }
  const allowed = new Set(rules.allowedExtensions);
  const out: DeclaredFile[] = [];
  const names = new Set<string>();
  files.forEach((raw: unknown) => {
    if (!isPlainObject(raw) || typeof raw.name !== 'string' || typeof raw.size !== 'number') {
      errors.push('A selected file is invalid.');
      return;
    }
    const name = stripPath(raw.name).trim();
    const type = typeof raw.type === 'string' ? raw.type.slice(0, 200) : '';
    const ext = getExtension(name);
    if (!name || name.length > 255) errors.push('A file name is missing or too long.');
    else if (!ext || !allowed.has(ext) || BLOCKED_EXTENSIONS.has(ext)) errors.push(`"${name}" is not an allowed file type.`);
    else if (!declaredTypeMatchesExtension(ext, type)) errors.push(`"${name}" does not look like a .${ext} file.`);
    if (!Number.isSafeInteger(raw.size) || raw.size < 1) errors.push(`"${name}" is empty.`);
    else if (raw.size > rules.maxFileSizeBytes) errors.push(`"${name}" is larger than ${formatBytes(rules.maxFileSizeBytes)}.`);
    const dupKey = `${name.toLowerCase()}|${raw.size}`;
    if (names.has(dupKey)) errors.push(`"${name}" was selected twice.`);
    names.add(dupKey);
    out.push({ name, size: raw.size, type });
  });
  return { errors, files: out };
}
