/**
 * Transport icons as inline SVG.
 *
 * Deliberately not Unicode glyphs. The media-control characters depend on a font that happens to
 * contain them, and where it does not the user gets tofu boxes in place of the play button — which
 * was exactly what happened the first time this UI was checked in a clean browser. SVG draws the
 * same everywhere and scales with the text.
 *
 * Every icon is paired with a text label or an accessible name at the call site, so the shape is
 * never the only thing carrying the meaning.
 */

interface IconProps {
  readonly size?: number;
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 16 16",
  fill: "currentColor",
  "aria-hidden": true as const,
  focusable: "false" as const,
});

export function SkipStartIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4 2.5h1.6v11H4zM14 3.2v9.6L6.6 8z" />
    </svg>
  );
}

export function SkipEndIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M10.4 2.5H12v11h-1.6zM2 3.2 9.4 8 2 12.8z" />
    </svg>
  );
}

export function StepBackIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12.5 3.2v9.6L5.8 8z" />
      <path d="M3 2.6h1.5v10.8H3z" />
    </svg>
  );
}

export function StepForwardIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M3.5 3.2 10.2 8 3.5 12.8z" />
      <path d="M11.5 2.6H13v10.8h-1.5z" />
    </svg>
  );
}

export function PlayIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4 2.6 13.5 8 4 13.4z" />
    </svg>
  );
}

export function PauseIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4 2.8h3.2v10.4H4zM8.8 2.8H12v10.4H8.8z" />
    </svg>
  );
}

/** Marks a value that changed at the current step. */
export function ChangedIcon({ size = 11 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M9.5 3 4 8l5.5 5V3z" />
    </svg>
  );
}
