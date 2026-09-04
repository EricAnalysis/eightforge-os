'use client';

import { createContext, useContext } from 'react';

// Transport credential only. Eligibility remains an authenticated server decision.
// The existing platform layout owns the auth client; consumers receive no database client.
export const PlatformSessionTokenContext = createContext<string | null>(null);

export function usePlatformSessionToken(): string | null {
  return useContext(PlatformSessionTokenContext);
}
