/**
 * Cold-start route is always the overlay. `/login` and `/servers` are
 * old UI; neither is an overlay destination. Zero stored servers still
 * open `/zen`, which shows the overlay Add server form.
 *
 * Stored count does not change the route. Unreachable and auth-rejected
 * servers still count as stored (the overlay stays on chats, not Add server).
 */
export function overlayHomePath(_storedServerCount?: number): "/zen" {
  return "/zen";
}
