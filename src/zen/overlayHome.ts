/**
 * Cold-start route is always the overlay (the pre-Zen `/login` and
 * `/servers` pages were removed in 4.1.0). Zero stored servers still
 * open `/zen`, which shows the overlay Add server form.
 *
 * Stored count does not change the route. Unreachable and auth-rejected
 * servers still count as stored (the overlay stays on chats, not Add server).
 */
export function overlayHomePath(_storedServerCount?: number): "/zen" {
  return "/zen";
}
