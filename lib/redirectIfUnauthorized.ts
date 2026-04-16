/**
 * Call after fetch() to redirect to login when the API returns 401 (e.g. session expired).
 * Returns true if redirect was triggered (caller should return), false otherwise.
 */
export function redirectIfUnauthorized(
  res: Response,
  replace: (url: string) => void,
): boolean {
  if (res.status === 401) {
    replace('/login');
    return true;
  }
  return false;
}
