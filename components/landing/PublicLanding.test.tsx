import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PublicLanding } from './PublicLanding';

describe('PublicLanding', () => {
  it('renders the approved positioning and operating model', () => {
    const html = renderToStaticMarkup(<PublicLanding />);
    const text = html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ');

    expect(html).toContain('Operational Systems Platform');
    expect(text).toContain('Turn document-heavy work into operational outcomes.');
    expect(html).toContain('EightForge structures the evidence, decisions, and workflows');
    expect(html.match(/<h1/g)).toHaveLength(1);

    for (const stage of ['Documents', 'Facts', 'Decisions', 'Outcomes']) {
      expect(html).toContain(`>${stage}<`);
    }
    expect(html).not.toContain('infinity-hero');
  });

  it('uses canonical product routes and keeps intake on the presentation layer', () => {
    const html = renderToStaticMarkup(<PublicLanding />);

    expect(html).toContain('href="/platform"');
    expect(html).toContain('href="/platform/documents"');
    expect(html).toContain('href="/platform/decisions"');
    expect(html).toContain('Describe Your Workflow');
    expect(html).toContain('What document-review workflow costs your team the most time?');
    expect(html).not.toContain('/evaluation/forgewing');
    expect(html).not.toContain('<form');
  });

  it('hides the operating-model artwork from assistive technology', () => {
    const html = renderToStaticMarkup(<PublicLanding />);
    expect(html).toMatch(
      /data-testid="operating-model-visual"[^>]*aria-hidden="true"|aria-hidden="true"[^>]*data-testid="operating-model-visual"/,
    );
  });
});
