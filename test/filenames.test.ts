import { describe, expect, it } from 'vitest';
import { buildStoredFilename, cleanOriginalFilename, getExtension, joinDrivePath, sanitiseBaseName, stripPath } from '../shared/filenames';

describe('filename sanitisation', () => {
  it('strips directory components from both separators', () => {
    expect(stripPath('../../etc/passwd')).toBe('passwd');
    expect(stripPath('C:\\Users\\x\\..\\report.pdf')).toBe('report.pdf');
  });

  it('extracts only safe lower-case extensions', () => {
    expect(getExtension('Photo.JPG')).toBe('jpg');
    expect(getExtension('archive.tar.gz')).toBe('gz');
    expect(getExtension('.htaccess')).toBe('');
    expect(getExtension('noext')).toBe('');
    expect(getExtension('trailing.')).toBe('');
    expect(getExtension('evil.p%68p')).toBe('');
  });

  it('removes traversal, reserved and unsafe characters from the base name', () => {
    expect(sanitiseBaseName('../../secret.pdf')).toBe('secret');
    expect(sanitiseBaseName('a<b>c:d"e|f?g*h.pdf')).toBe('a_b_c_d_e_f_g_h');
    expect(sanitiseBaseName('invoice.pdf.exe')).toBe('invoice_pdf');
    expect(sanitiseBaseName('CON.pdf')).toBe('file_CON');
    expect(sanitiseBaseName('~$lock.docx')).toBe('lock');
    expect(sanitiseBaseName('my_vti_file.pdf')).not.toMatch(/_vti_/i);
    expect(sanitiseBaseName('...pdf')).toBe('file');
    expect(sanitiseBaseName('\u202Egnp.exe.pdf')).toBe('gnp_exe');
    expect(sanitiseBaseName('na\u0000me\u0007.pdf')).toBe('name');
  });

  it('limits length and keeps unicode letters', () => {
    expect(sanitiseBaseName(`${'x'.repeat(300)}.pdf`).length).toBeLessThanOrEqual(80);
    expect(sanitiseBaseName('Café menü.pdf')).toBe('Café_menü');
  });

  it('builds a unique, server-controlled stored filename', () => {
    const name = buildStoredFilename({ originalName: '../Table 12 photo.PNG', reference: 'K7Q2-M9XD', index: 0, createdAt: new Date('2026-10-18T10:00:00Z') });
    expect(name).toBe('20261018_K7Q2-M9XD_01_Table_12_photo.png');
    expect(name).not.toContain('/');
    expect(() => buildStoredFilename({ originalName: 'noext', reference: 'A', index: 0, createdAt: new Date() })).toThrow();
  });

  it('cleans original names for display without trusting paths', () => {
    expect(cleanOriginalFilename('dir/sub/My File.pdf')).toBe('My File.pdf');
    expect(cleanOriginalFilename('\u0000')).toBe('file');
  });

  it('refuses to join names that would traverse', () => {
    expect(joinDrivePath('/Uploads/', 'a.pdf')).toBe('/Uploads/a.pdf');
    expect(() => joinDrivePath('/Uploads', '../a.pdf')).toThrow();
    expect(() => joinDrivePath('/Uploads', '..')).toThrow();
  });
});
