# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-18

### Added

- `scan` command / `scan_invisible_blockers` MCP tool: grid sweep that finds visually invisible
  elements (opacity 0, transparent empty wrappers, leftover backdrops, positioned `::before`/`::after`)
  covering visible interactive elements, confirmed with a real click, grouped by occluder.
- `inspect` command / `inspect_click_target` tool: hit test at 9 points plus real mouse clicks in
  desktop and mobile viewports, stacking-context chain analysis, verdicts
  (`OK`, `INVISIBLE_OCCLUDER`, `COVERED_BY_SIBLING_STACKING_CONTEXT`, `COVERED_BY_POSITIONED_ELEMENT`,
  `POINTER_EVENTS_NONE`, `INVISIBLE`, `OUTSIDE_VIEWPORT_OR_CLIPPED`, `ZERO_SIZE`, `NOT_FOUND`),
  plain-English explanations and minimal fix suggestions.
- `stack` command / `element_stack_at_point` tool: `elementsFromPoint` with stacking info.
- `rules` command / `css_rules_for_element` tool: rule attribution through the Chrome DevTools
  Protocol (cross-origin and `file://` stylesheets, source lines, cascade winner, pseudo-elements),
  with a CSSOM fallback.
- Pre-actions (`click`, `hover`, `focus`, `scroll`, `wait`, `press`), `--json`, `--screenshot`,
  exit codes for CI, Node API, `install-browser` helper.
