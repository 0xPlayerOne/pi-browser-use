const HINTS: Record<string, string> = {
  browser_click:
    "Use the element uid from the accessibility tree snapshot; UIDs are invalidated after this action.",
  browser_fill: "Fills standard HTML form fields only; does not work on canvas/custom widgets.",
  browser_press_key: "Accepts a single key name only (e.g. Enter, Tab, Escape).",
  browser_take_snapshot: "Call first to get uids, and after every state-changing action.",
  browser_navigate_page: "Call take_snapshot after navigation to see the new page.",
};

export function augmentToolDescription(prefixedName: string, description: string): string {
  const hint = HINTS[prefixedName];
  return hint ? `${description}\n\nHint: ${hint}` : description;
}

export function postProcessToolResult(originalName: string, text: string): string {
  if (originalName === "click" && /overlay|obscured|intercept/i.test(text)) {
    return `${text}\n\nHint: the click was blocked by an overlay/popup — dismiss it first, then refresh the snapshot.`;
  }
  if (/stale|no longer attached|not found/i.test(text) && /uid|element/i.test(text)) {
    return `${text}\n\nHint: element references are stale — take a fresh snapshot for current uids.`;
  }
  return text;
}

export function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item): item is { type: string; text?: string } => typeof item === "object" && item !== null
    )
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
}
