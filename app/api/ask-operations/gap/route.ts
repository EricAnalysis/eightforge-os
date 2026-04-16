import { NextRequest, NextResponse } from 'next/server';

import { getActorContext } from '@/lib/server/getActorContext';
import type { PortfolioIntentType } from '@/lib/operationsQuery/types';

const INTENT_TYPES: readonly PortfolioIntentType[] = [
  'PORTFOLIO_FACT',
  'PORTFOLIO_RANK',
  'PORTFOLIO_SIGNAL',
  'PORTFOLIO_LIST',
  'PORTFOLIO_SEARCH',
  'PORTFOLIO_ROUTE',
];

function isPortfolioIntentType(value: unknown): value is PortfolioIntentType {
  return typeof value === 'string' && (INTENT_TYPES as readonly string[]).includes(value);
}

/**
 * Silent coverage-gap log for Ask Operations NONE-confidence results.
 * Always responds 200; never surfaces errors to the client.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ ok: true });
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ ok: true });
    }

    const rec = body as Record<string, unknown>;
    const query = typeof rec.query === 'string' ? rec.query.trim() : '';
    if (!query) {
      return NextResponse.json({ ok: true });
    }

    const intentType = rec.intentType;
    if (!isPortfolioIntentType(intentType)) {
      return NextResponse.json({ ok: true });
    }

    const timestamp = typeof rec.timestamp === 'string' ? rec.timestamp : new Date().toISOString();
    const projectScope: 'portfolio' = 'portfolio';
    const confidence: 'NONE' = 'NONE';

    let userId: string | null = null;
    const authHeader = req.headers.get('authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const ctx = await getActorContext(req);
      if (ctx.ok) {
        userId = ctx.actor.actorId;
      }
    }

    console.info('[ask-operations:coverage-gap]', {
      query,
      intentType,
      timestamp,
      userId,
      projectScope,
      confidence,
    });
  } catch (err) {
    console.warn('[ask-operations:coverage-gap] ingest skipped', err);
  }

  return NextResponse.json({ ok: true });
}
