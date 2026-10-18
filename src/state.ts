// Submission lifecycle. Every status change in the database goes through
// `transitionStatement`, which turns the allowed predecessors into a WHERE
// clause so concurrent requests cannot race a submission into an invalid state.
import type { SubmissionStatus } from '../shared/types';

export const ALLOWED_TRANSITIONS: Readonly<Record<SubmissionStatus, readonly SubmissionStatus[]>> = {
  created: ['uploading', 'failed'],
  uploading: ['uploaded', 'failed'],
  uploaded: ['excel_pending', 'failed'],
  excel_pending: ['complete', 'failed'],
  complete: [],
  // Only Excel failures can be retried; the retry endpoint checks failure_stage.
  failed: ['excel_pending'],
};

export function canTransition(from: SubmissionStatus, to: SubmissionStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function predecessorsOf(to: SubmissionStatus): SubmissionStatus[] {
  return (Object.keys(ALLOWED_TRANSITIONS) as SubmissionStatus[]).filter((from) => canTransition(from, to));
}

/**
 * Builds an UPDATE that moves a submission to `to` only if it is currently in
 * one of `from` (which must all be legal predecessors). `extra` sets more columns.
 */
export function transitionStatement(
  db: D1Database,
  submissionId: string,
  from: SubmissionStatus[],
  to: SubmissionStatus,
  extra: Record<string, string | number | null> = {},
  nowMs = Date.now(),
): D1PreparedStatement {
  for (const f of from) {
    if (!canTransition(f, to)) throw new Error(`Illegal submission transition ${f} -> ${to}`);
  }
  const cols = Object.keys(extra);
  for (const c of cols) if (!/^[a-z_]+$/.test(c)) throw new Error('Invalid column');
  const sets = ['status = ?', 'updated_at = ?', ...cols.map((c) => `${c} = ?`)].join(', ');
  const placeholders = from.map(() => '?').join(', ');
  return db
    .prepare(`UPDATE submissions SET ${sets} WHERE id = ? AND status IN (${placeholders})`)
    .bind(to, nowMs, ...cols.map((c) => extra[c] ?? null), submissionId, ...from);
}

export async function transition(
  db: D1Database,
  submissionId: string,
  from: SubmissionStatus[],
  to: SubmissionStatus,
  extra: Record<string, string | number | null> = {},
  nowMs = Date.now(),
): Promise<boolean> {
  const r = await transitionStatement(db, submissionId, from, to, extra, nowMs).run();
  return r.meta.changes === 1;
}
