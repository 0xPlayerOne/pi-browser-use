import { homedir } from 'node:os'
import { join } from 'node:path'

export type ArtifactKind = 'screenshot' | 'html'

export function defaultArtifactDir(): string {
  return join(homedir(), '.pi', 'browser-artifacts')
}

/** Resolve the destination file: explicit path wins, otherwise a timestamped file in the default dir. */
export function resolveArtifactTarget(kind: ArtifactKind, path?: unknown): string {
  if (typeof path === 'string' && path.length > 0) return path
  return join(defaultArtifactDir(), `page-${Date.now()}.${kind === 'html' ? 'html' : 'png'}`)
}

interface ContentItem {
  type: string
  text?: string
  data?: string
  mimeType?: string
}

/** Pick the first image payload out of MCP content, if any. */
export function pickImageData(content: unknown): { data: string; mimeType: string } | undefined {
  if (!Array.isArray(content)) return undefined
  const found = (content as ContentItem[]).find((item) => item.type === 'image' && item.data)
  if (!found?.data) return undefined
  return { data: found.data, mimeType: found.mimeType ?? 'image/png' }
}
