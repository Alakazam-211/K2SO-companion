/** Signed-in home is the overlay. Zero servers still land on add-server. */
export function overlayHomePath(hasServers: boolean): "/zen" | "/servers" {
  return hasServers ? "/zen" : "/servers";
}
