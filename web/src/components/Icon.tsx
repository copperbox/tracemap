/** Inline SVG stroke glyphs from the design handoff. */

import styles from './Icon.module.css';

export const TYPE_ICONS: Record<string, string> = {
  postgres: 'M2 3.2 C2 1.6 10 1.6 10 3.2 L10 8.8 C10 10.4 2 10.4 2 8.8 Z M2 3.2 C2 4.8 10 4.8 10 3.2',
  redis: 'M6.5 1 L3 6.8 L5.6 6.8 L5 11 L9 5.2 L6.4 5.2 Z',
  kafka: 'M2 3 H10 M2 6 H7.5 M2 9 H10',
  elastic: 'M5 1.8 A3.2 3.2 0 1 0 5 8.2 A3.2 3.2 0 0 0 5 1.8 M7.4 7.4 L10.5 10.5',
  s3: 'M6 1.5 L10.5 4 V8 L6 10.5 L1.5 8 V4 Z M1.5 4 L6 6.5 L10.5 4 M6 6.5 V10.5',
  external:
    'M6 1.5 A4.5 4.5 0 1 0 6 10.5 A4.5 4.5 0 0 0 6 1.5 M1.5 6 H10.5 M6 1.5 C3.9 4 3.9 8 6 10.5 C8.1 8 8.1 4 6 1.5',
  service: 'M6 1 L10.3 3.5 V8.5 L6 11 L1.7 8.5 V3.5 Z',
  bff: 'M6 1.5 L10.5 4 L6 6.5 L1.5 4 Z M2.5 6.6 L6 8.6 L9.5 6.6',
  gateway: 'M2 10.5 V5 C2 2.2 10 2.2 10 5 V10.5 M4.8 10.5 V7.4 H7.2 V10.5',
  // Meganode glyph: three stacked hexagon-ish shapes (team of services).
  group: 'M3.5 1.5 H8.5 M2.5 4 H9.5 M1.5 6.5 L6 9.5 L10.5 6.5 M1.5 6.5 H10.5',
};

export const TYPE_LABELS: Record<string, string> = {
  postgres: 'POSTGRES',
  redis: 'REDIS',
  kafka: 'KAFKA',
  elastic: 'ELASTICSEARCH',
  s3: 'OBJECT STORE',
  external: 'EXTERNAL API',
  service: 'SERVICE',
  bff: 'BFF',
  gateway: 'GATEWAY',
  group: 'TEAM GROUP',
};

export function TypeIcon({ type, size = 11 }: { type: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" className={styles.noShrink}>
      <path
        d={TYPE_ICONS[type] ?? TYPE_ICONS.service}
        stroke="var(--faint)"
        strokeWidth="1.1"
        fill="none"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function CloseIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10">
      <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function ChevronIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 9 9" fill="none" className={styles.noShrink}>
      <path d="M3 1.5 L6.5 4.5 L3 7.5" stroke="var(--faint)" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function BackIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
      <path
        d="M7 1.5 L2.5 5.5 L7 9.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SearchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <circle cx="5.5" cy="5.5" r="4" stroke="var(--faint)" strokeWidth="1.4" />
      <path d="M8.6 8.6 L12 12" stroke="var(--faint)" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function ResetLayoutIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path
        d="M10.5 6 A4.5 4.5 0 1 1 8.8 2.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path d="M9 0.8 L9 3 L6.8 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function FitIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path
        d="M1 4 V1 H4 M8 1 H11 V4 M11 8 V11 H8 M4 11 H1 V8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ThemeIcon({ theme }: { theme: 'dark' | 'light' }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <g opacity={theme === 'dark' ? 1 : 0}>
        <path
          d="M11.5 8.6 A5 5 0 1 1 5.4 2.5 A4 4 0 0 0 11.5 8.6 Z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </g>
      <g opacity={theme === 'dark' ? 0 : 1}>
        <circle cx="7" cy="7" r="2.6" stroke="currentColor" strokeWidth="1.3" />
        <path
          d="M7 .8 V2.4 M7 11.6 V13.2 M.8 7 H2.4 M11.6 7 H13.2 M2.6 2.6 L3.7 3.7 M10.3 10.3 L11.4 11.4 M2.6 11.4 L3.7 10.3 M10.3 3.7 L11.4 2.6"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}

export function LogoIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <path d="M11 2 L20 11 L11 20 L2 11 Z" stroke="var(--accent)" strokeWidth="1.3" opacity="0.5" />
      <circle cx="11" cy="2" r="2" fill="var(--accent)" />
      <circle cx="20" cy="11" r="2" fill="var(--accent)" opacity="0.65" />
      <circle cx="2" cy="11" r="2" fill="var(--accent)" opacity="0.65" />
      <circle cx="11" cy="20" r="2" fill="var(--accent)" />
      <circle cx="11" cy="11" r="1.4" fill="var(--accent)" opacity="0.45" />
    </svg>
  );
}

export function GroupExpandIcon({ expanded }: { expanded: boolean }) {
  return expanded ? (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
      <path
        d="M4.5 1.5 H1.5 V4.5 M7.5 10.5 H10.5 V7.5 M1.5 7.5 V10.5 H4.5 M10.5 4.5 V1.5 H7.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  ) : (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
      <path
        d="M1.5 4.5 V1.5 H4.5 M7.5 1.5 H10.5 V4.5 M10.5 7.5 V10.5 H7.5 M4.5 10.5 H1.5 V7.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
