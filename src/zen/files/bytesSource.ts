// Where a viewer's bytes come from. By default `useFileBytes` reads the
// workspace file through the daemon (`fs/read-binary`, `fs/read-range`).
// A Thread attachment (K2 0.46.1) is not a path the phone may read
// directly: its sheet provides a loader that answers from
// `GET /cli/thread/attachment`, so the same viewers (image, PDF, media,
// DOCX, ZIP, 3D) paint it with no copy of their code.

import { createContext } from "react";

export type FileBytesLoader = (
  path: string,
  opts: { ranged: boolean; isCancelled: () => boolean; onProgress: (r: number) => void }
) => Promise<Uint8Array>;

/** null = the default daemon file read. */
export const FileBytesSourceContext = createContext<FileBytesLoader | null>(null);
