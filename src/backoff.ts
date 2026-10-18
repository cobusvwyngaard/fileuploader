export const REPORT_RETRY_BASE_MS = 60_000;
export const REPORT_RETRY_CAP_MS = 6 * 60 * 60 * 1000;
/** After this many failed attempts the submission is marked failed and needs an admin retry. */
export const REPORT_MAX_ATTEMPTS = 12;

/**
 * Capped exponential backoff with +/-20% jitter. `attempt` is the number of
 * attempts already made (1 after the first failure).
 */
export function reportRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const exp = REPORT_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(REPORT_RETRY_CAP_MS, exp);
  const jitter = 1 + (random() * 0.4 - 0.2);
  return Math.round(Math.min(REPORT_RETRY_CAP_MS, capped * jitter));
}
