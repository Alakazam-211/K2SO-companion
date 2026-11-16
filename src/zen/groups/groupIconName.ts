// A storable Home group icon name: a Lucide name, kebab-case, the shape the
// daemon accepts (`homes_sync::valid_icon`, K2 0.46.13). Whether this build
// can draw it is `./groupIcons`'s question; an unknown name draws as the
// group's number. Kept apart from the icon list so the sync code can check a
// name without loading the icons.
export const GROUP_ICON_NAME_RE = /^[a-z0-9-]{1,64}$/;
