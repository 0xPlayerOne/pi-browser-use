---
name: visual-qa
description: "Screenshot discipline for visual checks of WebGL/canvas scenes and layouts. Use when asked whether something \"looks right\", for before/after comparisons, or for viewport coverage."
---

# Visual QA

The accessibility tree cannot see canvas pixels. That is the only reason to look at screenshots — exhaust the tree first.

## Viewport matrix

Cover at least two sizes; small viewports catch most layout regressions:

```text
browser_resize_page({ "pageId": <id>, "width": 1280, "height": 720 })
browser_save_artifact({ "pageId": <id>, "kind": "screenshot" })
browser_resize_page({ "pageId": <id>, "width": 390, "height": 844 })
browser_save_artifact({ "pageId": <id>, "kind": "screenshot" })
```

Save, don't inline — `browser_save_artifact` returns paths. Inline `browser_take_screenshot` only for the frame you are judging this turn.

## When the tree is blind (canvas/WebGL)

1. `browser_analyze_screenshot` (requires `visionModel` config) for coordinates or element identification the tree cannot provide.
2. Feed coordinates to `browser_click_at` — never guess pixels yourself.
3. If the scene needs deterministic frames (animations, thumbnails), stop: that is `playwright-handoff` territory (`waitForFunction`, fixed timeouts, traces).

## Failure bar

A visual failure needs: what was expected, what rendered instead, the artifact path, and the viewport. "Looks off" without an artifact path is not a finding.

## Pixel-flakiness notes

- WebGL anti-aliasing and font rendering differ between headless (SwiftShader) and GPU browsers — compare like with like.
- Allow one retry for animation timing before calling a failure.
- Animations mid-frame are not bugs; wait for idle, then capture.
