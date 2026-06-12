type HexColor = `#${string}`;

export const EIGHTFORGE_COLORS = {
  background_primary: '#07071A',
  background_black: '#05050D',
  background_panel: '#0B0D18',
  background_panel_soft: '#111827',
  text_primary: '#F5F7FA',
  text_secondary: '#CBD5E1',
  text_muted: '#8B94A3',
  purple_primary: '#8B5CFF',
  purple_glow: '#B794FF',
  purple_accent: '#A66BFF',
  purple_bg_subtle: 'rgba(139, 92, 255, 0.10)',
  purple_border: 'rgba(139, 92, 255, 0.40)',
  border_subtle: 'rgba(245, 247, 250, 0.08)',
  border_strong: 'rgba(245, 247, 250, 0.14)',
  critical: '#FF4D4F',
  critical_bg: 'rgba(255, 77, 79, 0.10)',
  warning: '#F5A623',
  warning_bg: 'rgba(245, 166, 35, 0.10)',
  success: '#22C55E',
  success_bg: 'rgba(34, 197, 94, 0.10)',
} as const;

function hexToRgb(hex: HexColor): [number, number, number] {
  const normalized = hex.replace('#', '');
  const value =
    normalized.length === 3
      ? normalized
          .split('')
          .map((segment) => segment + segment)
          .join('')
      : normalized;

  const int = Number.parseInt(value, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function rgba(hex: HexColor, alpha: number): string {
  const [red, green, blue] = hexToRgb(hex);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function mix(first: HexColor, second: HexColor, weight: number): string {
  const [firstRed, firstGreen, firstBlue] = hexToRgb(first);
  const [secondRed, secondGreen, secondBlue] = hexToRgb(second);
  const blend = (left: number, right: number) =>
    Math.round(left * (1 - weight) + right * weight);

  return `rgb(${blend(firstRed, secondRed)}, ${blend(firstGreen, secondGreen)}, ${blend(firstBlue, secondBlue)})`;
}

function mixRgba(first: HexColor, second: HexColor, weight: number, alpha: number): string {
  const [firstRed, firstGreen, firstBlue] = hexToRgb(first);
  const [secondRed, secondGreen, secondBlue] = hexToRgb(second);
  const blend = (left: number, right: number) =>
    Math.round(left * (1 - weight) + right * weight);

  return `rgba(${blend(firstRed, secondRed)}, ${blend(firstGreen, secondGreen)}, ${blend(firstBlue, secondBlue)}, ${alpha})`;
}

const {
  background_primary,
  background_black,
  background_panel,
  background_panel_soft,
  text_primary,
  text_secondary,
  text_muted,
  purple_primary,
  purple_glow,
  purple_accent,
  purple_bg_subtle,
  purple_border,
  border_subtle,
  border_strong,
  critical,
  critical_bg,
  warning,
  warning_bg,
  success,
  success_bg,
} = EIGHTFORGE_COLORS;

export const EIGHTFORGE_THEME_VARIABLES = {
  '--ef-background-primary': background_primary,
  '--ef-background-black': background_black,
  '--ef-background-panel': background_panel,
  '--ef-background-panel-soft': background_panel_soft,
  '--ef-background-secondary': background_panel,
  '--ef-text-primary': text_primary,
  '--ef-text-muted': text_muted,
  '--ef-text-secondary': text_secondary,
  '--ef-purple-primary': purple_primary,
  '--ef-purple-glow': purple_glow,
  '--ef-purple-accent': purple_accent,
  '--ef-purple-bg-subtle': purple_bg_subtle,
  '--ef-purple-border': purple_border,
  '--ef-critical': critical,
  '--ef-critical-bg': critical_bg,
  '--ef-warning': warning,
  '--ef-warning-bg': warning_bg,
  '--ef-success': success,
  '--ef-success-bg': success_bg,
  '--ef-text-soft': rgba(text_primary, 0.68),
  '--ef-text-faint': rgba(text_primary, 0.56),
  '--ef-text-ghost': rgba(text_primary, 0.42),
  '--ef-border-subtle': border_subtle,
  '--ef-border-strong': border_strong,
  '--ef-border-subtle-a30': 'rgba(245, 247, 250, 0.03)',
  '--ef-border-subtle-a40': 'rgba(245, 247, 250, 0.04)',
  '--ef-border-subtle-a50': 'rgba(245, 247, 250, 0.05)',
  '--ef-border-subtle-a60': 'rgba(245, 247, 250, 0.06)',
  '--ef-border-subtle-a70': 'rgba(245, 247, 250, 0.07)',
  '--ef-border-subtle-a80': 'rgba(245, 247, 250, 0.08)',
  '--ef-border-white-10': 'rgba(245, 247, 250, 0.10)',
  '--ef-border-white-06': 'rgba(245, 247, 250, 0.06)',
  '--ef-surface-panel': background_panel,
  '--ef-surface-elevated': mix(background_panel as HexColor, text_primary, 0.06),
  '--ef-surface-hover': mix(background_panel as HexColor, text_primary, 0.11),
  '--ef-surface-contrast': mix(background_panel as HexColor, text_primary, 0.16),
  '--ef-surface-overlay': rgba(background_primary, 0.92),
  '--ef-glass-panel': rgba(background_panel as HexColor, 0.82),
  '--ef-shadow-soft': rgba(background_primary, 0.28),
  '--ef-shadow-medium': rgba(background_primary, 0.35),
  '--ef-shadow-ambient': rgba(background_primary, 0.95),
  '--ef-shadow-overlay': rgba(background_primary, 0.78),
  '--ef-shadow-deep': rgba(background_primary, 1),
  '--ef-background-primary-a20': rgba(background_primary, 0.2),
  '--ef-background-primary-a40': rgba(background_primary, 0.4),
  '--ef-background-primary-a60': rgba(background_primary, 0.6),
  '--ef-background-primary-a88': rgba(background_primary, 0.88),
  '--ef-background-primary-a92': rgba(background_primary, 0.92),
  '--ef-background-primary-a95': rgba(background_primary, 0.95),
  '--ef-background-secondary-a70': rgba(background_panel as HexColor, 0.7),
  '--ef-background-secondary-a80': rgba(background_panel as HexColor, 0.8),
  '--ef-surface-elevated-a80': mixRgba(background_panel as HexColor, text_primary, 0.06, 0.8),
  '--ef-surface-hover-a60': mixRgba(background_panel as HexColor, text_primary, 0.11, 0.6),
  '--ef-surface-hover-a70': mixRgba(background_panel as HexColor, text_primary, 0.11, 0.7),
  '--ef-purple-primary-a04': rgba(purple_primary, 0.04),
  '--ef-purple-primary-a06': rgba(purple_primary, 0.06),
  '--ef-purple-primary-a08': rgba(purple_primary, 0.08),
  '--ef-purple-primary-a10': rgba(purple_primary, 0.1),
  '--ef-purple-primary-a12': rgba(purple_primary, 0.12),
  '--ef-purple-primary-a14': rgba(purple_primary, 0.14),
  '--ef-purple-primary-a15': rgba(purple_primary, 0.15),
  '--ef-purple-primary-a16': rgba(purple_primary, 0.16),
  '--ef-purple-primary-a18': rgba(purple_primary, 0.18),
  '--ef-purple-primary-a20': rgba(purple_primary, 0.2),
  '--ef-purple-primary-a25': rgba(purple_primary, 0.25),
  '--ef-purple-primary-a30': rgba(purple_primary, 0.3),
  '--ef-purple-primary-a35': rgba(purple_primary, 0.35),
  '--ef-purple-primary-a40': rgba(purple_primary, 0.4),
  '--ef-purple-primary-a45': rgba(purple_primary, 0.45),
  '--ef-purple-primary-a50': rgba(purple_primary, 0.5),
  '--ef-purple-primary-a60': rgba(purple_primary, 0.6),
  '--ef-purple-glow-a10': rgba(purple_glow, 0.1),
  '--ef-purple-glow-a15': rgba(purple_glow, 0.15),
  '--ef-purple-glow-a20': rgba(purple_glow, 0.2),
  '--ef-purple-glow-a25': rgba(purple_glow, 0.25),
  '--ef-purple-glow-a30': rgba(purple_glow, 0.3),
  '--ef-purple-glow-a40': rgba(purple_glow, 0.4),
  '--ef-purple-glow-a70': rgba(purple_glow, 0.7),
  '--ef-purple-accent-a25': rgba(purple_accent, 0.25),
  '--ef-purple-accent-a30': rgba(purple_accent, 0.3),
  '--ef-purple-ring': rgba(purple_glow, 0.34),
  '--ef-warning-a08': rgba(warning, 0.08),
  '--ef-warning-a10': rgba(warning, 0.1),
  '--ef-warning-a18': rgba(warning, 0.18),
  '--ef-warning-a20': rgba(warning, 0.2),
  '--ef-warning-a30': rgba(warning, 0.3),
  '--ef-warning-a35': rgba(warning, 0.35),
  '--ef-warning-a40': rgba(warning, 0.4),
  '--ef-warning-soft': mix(warning, text_primary, 0.42),
  '--ef-critical-a05': rgba(critical, 0.05),
  '--ef-critical-a08': rgba(critical, 0.08),
  '--ef-critical-a10': rgba(critical, 0.1),
  '--ef-critical-a12': rgba(critical, 0.12),
  '--ef-critical-a15': rgba(critical, 0.15),
  '--ef-critical-a18': rgba(critical, 0.18),
  '--ef-critical-a20': rgba(critical, 0.2),
  '--ef-critical-a30': rgba(critical, 0.3),
  '--ef-critical-a40': rgba(critical, 0.4),
  '--ef-critical-a45': rgba(critical, 0.45),
  '--ef-critical-soft': mix(critical, text_primary, 0.42),
  '--ef-success-a06': rgba(success, 0.06),
  '--ef-success-a08': rgba(success, 0.08),
  '--ef-success-a10': rgba(success, 0.1),
  '--ef-success-a18': rgba(success, 0.18),
  '--ef-success-a20': rgba(success, 0.2),
  '--ef-success-a30': rgba(success, 0.3),
  '--ef-success-a35': rgba(success, 0.35),
  '--ef-success-a40': rgba(success, 0.4),
  '--ef-success-a50': rgba(success, 0.5),
  '--ef-success-soft': mix(success, text_primary, 0.38),
} as const;

function serializeCssVariables(variables: Record<string, string>): string {
  return Object.entries(variables)
    .map(([key, value]) => `${key}:${value};`)
    .join('');
}

export const EIGHTFORGE_THEME_STYLE_TEXT = `:root{${serializeCssVariables(EIGHTFORGE_THEME_VARIABLES)}}`;
