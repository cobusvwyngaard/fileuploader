import { describe, expect, it } from 'vitest';
import type { FieldDefinition, FileRules } from '../shared/types';
import { declaredTypeMatchesExtension, validateDeclaredFiles, validateFieldDefinitions, validateFieldValues, validateFileRules, validateSessionConfig } from '../shared/validation';
import { sessionConfig } from './helpers';

const fields: FieldDefinition[] = [
  { label: 'Table number', key: 'table_number', type: 'number', required: true },
  { label: 'Description', key: 'description', type: 'textarea', required: false },
  { label: 'Email', key: 'email', type: 'email', required: false },
  { label: 'Area', key: 'area', type: 'select', required: true, options: ['North', 'South'] },
  { label: 'Reference', key: 'reference_number', type: 'text', required: false },
];

describe('field value validation', () => {
  it('accepts valid values and normalises them', () => {
    const r = validateFieldValues(fields, { table_number: ' 12 ', description: '  hello ', email: 'a@b.co', area: 'North' });
    expect(r.errors).toEqual({});
    expect(r.values).toEqual({ table_number: 12, description: 'hello', email: 'a@b.co', area: 'North' });
  });

  it('reports required, type and option errors', () => {
    const r = validateFieldValues(fields, { table_number: 'twelve', email: 'nope', area: 'West' });
    expect(r.errors.table_number).toMatch(/number/);
    expect(r.errors.email).toMatch(/email/);
    expect(r.errors.area).toMatch(/valid option/);
    expect(validateFieldValues(fields, {}).errors.table_number).toMatch(/required/);
  });

  it('rejects unknown keys, objects, oversized and control-character values', () => {
    const r = validateFieldValues(fields, { table_number: 1, area: 'North', injected: 'x', reference_number: { a: 1 } });
    expect(r.errors.injected).toBeDefined();
    expect(r.errors.reference_number).toBeDefined();
    expect(validateFieldValues(fields, { table_number: 1, area: 'North', reference_number: 'x'.repeat(201) }).errors.reference_number).toBeDefined();
    expect(validateFieldValues(fields, { table_number: 1, area: 'North', reference_number: 'a\u0000b' }).errors.reference_number).toBeDefined();
    expect(validateFieldValues(fields, null).errors._form).toBeDefined();
  });
});

describe('field definitions', () => {
  it('requires label, valid unique keys and dropdown options', () => {
    expect(validateFieldDefinitions(fields)).toEqual([]);
    expect(validateFieldDefinitions([{ label: '', key: 'Bad Key', type: 'text', required: true }]).length).toBeGreaterThanOrEqual(2);
    expect(validateFieldDefinitions([fields[0], fields[0]]).join()).toMatch(/more than once/);
    expect(validateFieldDefinitions([{ label: 'X', key: 'x', type: 'select', required: true, options: [] }]).join()).toMatch(/at least one option/);
    expect(validateFieldDefinitions([{ label: 'X', key: 'x', type: 'text', required: true, options: ['a'] }]).join()).toMatch(/only dropdown/);
  });

  it('prevents fields from colliding with standard Excel columns', () => {
    expect(validateFieldDefinitions([{ label: 'X', key: 'stored_filename', type: 'text', required: false }]).join()).toMatch(/clashes/);
    expect(validateFieldDefinitions([{ label: 'X', key: 'x', type: 'text', required: false, excelColumn: 'Session_Title' }]).join()).toMatch(/clashes/);
  });
});

describe('file rules and declared files', () => {
  const rules: FileRules = { allowedExtensions: ['pdf', 'png'], maxFileSizeBytes: 1000, maxFilesPerSubmission: 2 };

  it('validates the admin file rules', () => {
    expect(validateFileRules(rules)).toEqual([]);
    expect(validateFileRules({ ...rules, allowedExtensions: ['exe'] }).join()).toMatch(/blocked/);
    expect(validateFileRules({ ...rules, allowedExtensions: [] }).length).toBe(1);
    expect(validateFileRules({ ...rules, maxFilesPerSubmission: 0 }).length).toBe(1);
    expect(validateFileRules({ ...rules, maxFileSizeBytes: 1.5 }).length).toBe(1);
  });

  it('enforces count, extension, size and type', () => {
    expect(validateDeclaredFiles(rules, [{ name: 'a.pdf', size: 10, type: 'application/pdf' }]).errors).toEqual([]);
    expect(validateDeclaredFiles(rules, []).errors.length).toBe(1);
    expect(validateDeclaredFiles(rules, [1, 2, 3].map((i) => ({ name: `${i}.pdf`, size: 1, type: '' }))).errors.join()).toMatch(/At most 2/);
    expect(validateDeclaredFiles(rules, [{ name: 'a.docx', size: 1, type: '' }]).errors.join()).toMatch(/not an allowed/);
    expect(validateDeclaredFiles(rules, [{ name: 'a.pdf', size: 1001, type: '' }]).errors.join()).toMatch(/larger than/);
    expect(validateDeclaredFiles(rules, [{ name: 'a.pdf', size: 0, type: '' }]).errors.join()).toMatch(/empty/);
    expect(validateDeclaredFiles(rules, [{ name: 'a.pdf', size: 5, type: 'image/png' }]).errors.join()).toMatch(/does not look like/);
    expect(validateDeclaredFiles({ ...rules, allowedExtensions: ['exe', 'pdf'] }, [{ name: 'a.exe', size: 1, type: '' }]).errors.length).toBe(1);
  });

  it('allows generic or empty browser MIME types', () => {
    expect(declaredTypeMatchesExtension('pdf', '')).toBe(true);
    expect(declaredTypeMatchesExtension('pdf', 'application/octet-stream')).toBe(true);
    expect(declaredTypeMatchesExtension('csv', 'application/vnd.ms-excel')).toBe(true);
    expect(declaredTypeMatchesExtension('png', 'image/jpeg')).toBe(false);
  });
});

describe('session configuration', () => {
  const now = new Date();
  it('accepts drafts without folder but requires them to publish', () => {
    const draft = sessionConfig({ folder: null });
    expect(validateSessionConfig(draft, { forPublish: false, now }).errors).toEqual([]);
    expect(validateSessionConfig(draft, { forPublish: true, now }).errors.join()).toMatch(/destination folder/);
  });

  it('requires a future expiry to publish', () => {
    const past = sessionConfig({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(validateSessionConfig(past, { forPublish: true, now }).errors.join()).toMatch(/future/);
    expect(validateSessionConfig(sessionConfig({ expiresAt: null }), { forPublish: true, now }).errors.join()).toMatch(/expiry/);
  });

  it('normalises extensions and trims values', () => {
    const r = validateSessionConfig(sessionConfig({ title: '  T  ', fileRules: { allowedExtensions: ['.PDF', 'pdf', ' png'], maxFileSizeBytes: 5, maxFilesPerSubmission: 1 } }), { forPublish: true, now });
    expect(r.value?.title).toBe('T');
    expect(r.value?.fileRules.allowedExtensions).toEqual(['pdf', 'png']);
  });
});
