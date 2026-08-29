import type { CSSProperties } from 'react';
import Link from 'next/link';
import { ChartNoAxesCombined, CircleCheck, FileText, Grid2X2 } from 'lucide-react';
import { EightForgeLogo } from '@/components/ui/EightForgeLogo';
import { WorkflowIntakeDialog } from './WorkflowIntakeDialog';
import styles from './PublicLanding.module.css';

const STAGES = [
  { label: 'Documents', Icon: FileText },
  { label: 'Facts', Icon: Grid2X2 },
  { label: 'Decisions', Icon: CircleCheck },
  { label: 'Outcomes', Icon: ChartNoAxesCombined },
] as const;

const ACTIONS = [
  { label: 'Overview', href: '/platform', Icon: Grid2X2 },
  { label: 'Docs', href: '/platform/documents', Icon: FileText },
  { label: 'Decisions', href: '/platform/decisions', Icon: CircleCheck },
] as const;

function OperatingModelVisual() {
  return (
    <div className={styles.modelVisual} aria-hidden="true" data-testid="operating-model-visual">
      <div className={styles.modelGlow} />
      <div className={styles.stream}>
        <span />
        <span />
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
      <div className={styles.stageGrid}>
        {STAGES.map(({ label, Icon }, index) => (
          <div
            className={styles.stage}
            style={{ '--stage-index': index } as CSSProperties}
            key={label}
          >
            <Icon className={styles.stageIcon} strokeWidth={1.45} />
            <span>{label}</span>
          </div>
        ))}
      </div>
      <div className={styles.terminalPoint} />
    </div>
  );
}

export function PublicLanding() {
  return (
    <main className={styles.page}>
      <div className={styles.ambientGlow} aria-hidden="true" />
      <div className={styles.shell}>
        <header className={styles.brand}>
          <EightForgeLogo size={34} />
          <span>EightForge</span>
        </header>

        <section className={styles.hero} aria-labelledby="landing-title">
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>Operational Systems Platform</p>
            <h1 id="landing-title">
              Turn document-heavy<span className={styles.desktopBreak}><br /></span>{' '}
              work into operational<span className={styles.desktopBreak}><br /></span>{' '}
              outcomes.
            </h1>
            <p className={styles.supportingCopy}>
              EightForge structures the evidence, decisions, and workflows that power your
              operations. Forgewing understands the work so your team can focus on what matters.
            </p>

            <nav className={styles.actions} aria-label="Platform entry points">
              {ACTIONS.map(({ label, href, Icon }) => (
                <Link className={styles.secondaryAction} href={href} key={label}>
                  <Icon aria-hidden="true" strokeWidth={1.7} />
                  <span>{label}</span>
                </Link>
              ))}
              <WorkflowIntakeDialog />
            </nav>
          </div>

          <OperatingModelVisual />
        </section>
      </div>
    </main>
  );
}
