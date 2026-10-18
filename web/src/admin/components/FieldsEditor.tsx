import { FIELD_TYPES, type FieldDefinition, type FieldType } from '../../../../shared/types';

const TYPE_LABELS: Record<FieldType, string> = {
  text: 'Short text',
  textarea: 'Long text',
  email: 'Email',
  number: 'Number',
  select: 'Dropdown',
};

export const keyFromLabel = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '')
    .slice(0, 40);

export const FIELD_PRESETS: FieldDefinition[] = [
  { label: 'Table number', key: 'table_number', type: 'text', required: true },
  { label: 'Description', key: 'description', type: 'textarea', required: false },
  { label: 'Name', key: 'name', type: 'text', required: false },
  { label: 'Email', key: 'email', type: 'email', required: false },
  { label: 'Reference number', key: 'reference_number', type: 'text', required: false },
];

export function FieldsEditor({ fields, onChange }: { fields: FieldDefinition[]; onChange: (f: FieldDefinition[]) => void }) {
  const update = (i: number, patch: Partial<FieldDefinition>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...fields];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    onChange(next);
  };
  const unusedPresets = FIELD_PRESETS.filter((p) => !fields.some((f) => f.key === p.key));

  return (
    <div>
      {fields.length === 0 && <p className="muted">No form fields. Uploaders will only choose files.</p>}
      {fields.map((f, i) => {
        const id = `f${i}`;
        return (
          <fieldset className="field-editor" key={i}>
            <legend className="visually-hidden">Field {i + 1}</legend>
            <div className="grid">
              <div className="field">
                <label htmlFor={`${id}-label`}>Label</label>
                <input
                  id={`${id}-label`}
                  type="text"
                  value={f.label}
                  onChange={(e) => {
                    const label = e.target.value;
                    // Keep the key following the label until the admin edits the key themselves.
                    const autoKey = !f.key || f.key === keyFromLabel(f.label);
                    update(i, { label, ...(autoKey ? { key: keyFromLabel(label) } : {}) });
                  }}
                />
              </div>
              <div className="field">
                <label htmlFor={`${id}-key`}>Internal key</label>
                <input id={`${id}-key`} type="text" value={f.key} onChange={(e) => update(i, { key: e.target.value.toLowerCase() })} />
              </div>
              <div className="field">
                <label htmlFor={`${id}-type`}>Type</label>
                <select
                  id={`${id}-type`}
                  value={f.type}
                  onChange={(e) => {
                    const type = e.target.value as FieldType;
                    update(i, { type, options: type === 'select' ? f.options ?? [] : undefined });
                  }}
                >
                  {FIELD_TYPES.map((t) => (
                    <option key={t} value={t}>{TYPE_LABELS[t]}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor={`${id}-col`}>Excel column</label>
                <input id={`${id}-col`} type="text" placeholder={f.key} value={f.excelColumn ?? ''} onChange={(e) => update(i, { excelColumn: e.target.value || undefined })} />
              </div>
            </div>
            {f.type === 'select' && (
              <div className="field">
                <label htmlFor={`${id}-opts`}>Dropdown options (one per line)</label>
                <textarea
                  id={`${id}-opts`}
                  value={(f.options ?? []).join('\n')}
                  onChange={(e) => update(i, { options: e.target.value.split('\n') })}
                  onBlur={() => update(i, { options: (f.options ?? []).map((o) => o.trim()).filter(Boolean) })}
                />
              </div>
            )}
            <div className="field">
              <label htmlFor={`${id}-help`}>Help text (optional)</label>
              <input id={`${id}-help`} type="text" value={f.helpText ?? ''} onChange={(e) => update(i, { helpText: e.target.value || undefined })} />
            </div>
            <div className="row">
              <label className="checkbox">
                <input type="checkbox" checked={f.required} onChange={(e) => update(i, { required: e.target.checked })} /> Required
              </label>
              <span className="spacer" />
              <button type="button" className="btn small" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${f.label || 'field'} up`}>↑</button>
              <button type="button" className="btn small" disabled={i === fields.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${f.label || 'field'} down`}>↓</button>
              <button type="button" className="btn small danger" onClick={() => onChange(fields.filter((_, j) => j !== i))}>Remove</button>
            </div>
          </fieldset>
        );
      })}
      <div className="row">
        <button type="button" className="btn" onClick={() => onChange([...fields, { label: '', key: '', type: 'text', required: false }])}>
          + Add field
        </button>
        {unusedPresets.map((p) => (
          <button key={p.key} type="button" className="btn small" onClick={() => onChange([...fields, { ...p }])}>
            + {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}
