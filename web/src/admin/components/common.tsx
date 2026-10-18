import { STATE_LABELS } from '../format';

export function Badge({ value }: { value: string }) {
  return <span className={`badge ${value}`}>{STATE_LABELS[value] ?? value}</span>;
}

export function ErrorAlert({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <div className="alert error" role="alert">
      {error}
    </div>
  );
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong.';
}
