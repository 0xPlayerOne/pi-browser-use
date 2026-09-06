---
name: dogfood
description: "Exploratory testing playbook for bug hunts and quality passes. Use when asked to dogfood, poke at, or break a site — tour it with intent instead of clicking around."
---

# Dogfood Tour

Exploratory testing with charters, not random clicking. Timebox: 30 minutes per charter, then report.

## Charters (pick one per run)

- **First-run**: fresh isolated session, no logins. Can a stranger complete the core flow?
- **Return user**: persistent profile, existing state. Does yesterday's data render correctly today?
- **Hostile input**: long strings, emoji, empty submits, rapid double-clicks, back-button mid-flow.
- **Small screen**: 390px wide. Overlaps, clipped actions, unreachable buttons.
- **Flaky network**: DevTools emulation throttling (see `browser_emulate`). Skeletons, retries, stuck spinners.

## Rules

1. One charter at a time; note which charter each finding came from.
2. Every finding needs: charter, repro steps (3 max), expected vs actual, artifact path via `browser_save_artifact`.
3. Console triage applies (`triage-console`) — a finding with a console error attached outranks one without.
4. Stop at crashes, data loss, or auth bypasses; report immediately, do not keep touring.
5. End with the top 3, not top 30. Severity beats inventory.

## Out of scope

Performance numbers (that's a benchmark, not a bug hunt), copy Voice (flag once, move on), and third-party outages (verify on a second network before filing).
