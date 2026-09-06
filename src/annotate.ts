/**
 * Numbered-badge annotation for screenshots (adapted from the technique
 * popularized by vercel-labs/agent-browser).
 *
 * Badges are injected around visible interactive elements, screenshotted,
 * then removed. The returned coordinate map pairs each badge number with a
 * viewport center point for coordinate click tools, plus a short label so
 * vision models can resolve "click the blue submit button" to (x, y).
 */

export interface AnnotatedElement {
  n: number
  x: number
  y: number
  tag: string
  text: string
}

export const ANNOTATE_MARKER = 'data-pi-annotate'

export const INJECT_ANNOTATIONS = `() => {
  document.querySelectorAll('[${ANNOTATE_MARKER}]').forEach((el) => el.remove());
  const els = [...document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="switch"]')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && r.top < window.innerHeight && r.left < window.innerWidth;
  }).slice(0, 50);
  return els.map((el, i) => {
    const r = el.getBoundingClientRect();
    const badge = document.createElement('div');
    badge.setAttribute('${ANNOTATE_MARKER}', '1');
    badge.textContent = String(i + 1);
    badge.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;z-index:2147483647;background:#7c3aed;color:#fff;font:12px/1.4 monospace;padding:1px 5px;border-radius:3px;pointer-events:none;';
    document.body.appendChild(badge);
    const label = el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
    return { n: i + 1, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: el.tagName.toLowerCase(), text: String(label).replace(/\\s+/g, ' ').slice(0, 60) };
  });
}`

export const CLEANUP_ANNOTATIONS = `() => {
  const badges = document.querySelectorAll('[${ANNOTATE_MARKER}]');
  const count = badges.length;
  badges.forEach((el) => el.remove());
  return count;
}`

/**
 * Upstream evaluate_script wraps results as prose around a ```json fence.
 * Extract the payload array robustly.
 */
export function parseAnnotatedElements(text: string): AnnotatedElement[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return []
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (item): item is AnnotatedElement =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as AnnotatedElement).n === 'number' &&
          typeof (item as AnnotatedElement).x === 'number' &&
          typeof (item as AnnotatedElement).y === 'number'
      )
      .map((item) => ({
        n: item.n,
        x: item.x,
        y: item.y,
        tag: typeof item.tag === 'string' ? item.tag : '',
        text: typeof item.text === 'string' ? item.text : '',
      }))
  } catch {
    return []
  }
}

/** Render the coordinate map as compact text for tool results. */
export function formatAnnotatedMap(elements: AnnotatedElement[]): string {
  if (elements.length === 0) return 'No interactive elements annotated.'
  return elements
    .map((el) => `${el.n}: (${el.x}, ${el.y}) ${el.tag}${el.text ? ` "${el.text}"` : ''}`)
    .join('\n')
}
