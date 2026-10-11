import type { ReactNode, SVGProps } from "react";

// The app's stroke icons, one definition each. 24×24 viewBox, drawn in
// `currentColor`, decorative (`aria-hidden`): the control around an icon
// carries the words. Call sites pick the size and stroke width; every
// icon marks itself with `data-k2-icon` so tests can tell which one drew.

export type IconProps = Omit<SVGProps<SVGSVGElement>, "children" | "ref" | "name"> & {
  /** Width and height (px). */
  size?: number;
  /** Lands on `data-testid`. */
  testId?: string;
};

export type IconName =
  | "home"
  | "agent"
  | "cog"
  | "terminal"
  | "pencil"
  | "file"
  | "search"
  | "check";

function Icon({
  name,
  size = 18,
  strokeWidth = 2,
  testId,
  children,
  ...rest
}: IconProps & { name: IconName; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      data-k2-icon={name}
      data-testid={testId}
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Desktop Garden nav rail HomeIcon (`ZenNavRailWidget.tsx`). */
export function HomeIcon(props: IconProps) {
  return (
    <Icon name="home" {...props}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V20h5v-6h4v6h5V9.5" />
    </Icon>
  );
}

/** Desktop Garden nav rail AgentIcon: the robot (Home | Agents toggle,
 *  the drawer's subagents counter). */
export function AgentIcon(props: IconProps) {
  return (
    <Icon name="agent" {...props}>
      <rect x="4" y="7" width="16" height="12" rx="3" />
      <path d="M12 3v4" />
      <circle cx="9" cy="13" r="1" />
      <circle cx="15" cy="13" r="1" />
      <path d="M2 12v3M22 12v3" />
    </Icon>
  );
}

/** Cog (lucide "settings"): the Agents header's Settings button. */
export function CogIcon(props: IconProps) {
  return (
    <Icon name="cog" {...props}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

/** The `>_` console: the chat header's Terminal button, plain shells. */
export function TerminalIcon(props: IconProps) {
  return (
    <Icon name="terminal" {...props}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </Icon>
  );
}

/** Pencil (feather "edit-2"): the terminal's Claimer toggle. */
export function PencilIcon(props: IconProps) {
  return (
    <Icon name="pencil" {...props}>
      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </Icon>
  );
}

/** A page with a folded corner (lucide "file"): the chat header's Files
 *  button, a file the viewer cannot show. */
export function FileIcon(props: IconProps) {
  return (
    <Icon name="file" {...props}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </Icon>
  );
}

/** Magnifier (feather "search"). */
export function SearchIcon(props: IconProps) {
  return (
    <Icon name="search" {...props}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </Icon>
  );
}

/** Check mark: picked rows (Home menu, focus groups, Add Agent), and the
 *  drawer's finished subagents. */
export function CheckIcon(props: IconProps) {
  return (
    <Icon name="check" {...props}>
      <path d="M20 6 9 17l-5-5" />
    </Icon>
  );
}
