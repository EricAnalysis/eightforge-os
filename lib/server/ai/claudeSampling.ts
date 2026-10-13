/**
 * Claude 5 and later reject sampling parameters, including `temperature: 0`.
 * Preserve the established 4.6 request contract so switching the model env var
 * back remains a complete rollback.
 */
export function getClaudeSamplingParameters(model: string): { temperature?: 0 } {
  const version = /^claude-[a-z]+-(\d+)(?:-(\d+))?(?:-|$)/u.exec(model.trim().toLowerCase());
  const major = Number(version?.[1]);
  const minor = Number(version?.[2] ?? 0);
  const isNewSamplingContract = major >= 5 || (major === 4 && minor >= 7);

  return isNewSamplingContract ? {} : { temperature: 0 };
}
