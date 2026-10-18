export type Verdict =
  | 'OK'
  | 'INVISIBLE_OCCLUDER'
  | 'COVERED_BY_SIBLING_STACKING_CONTEXT'
  | 'COVERED_BY_POSITIONED_ELEMENT'
  | 'POINTER_EVENTS_NONE'
  | 'INVISIBLE'
  | 'OUTSIDE_VIEWPORT_OR_CLIPPED'
  | 'ZERO_SIZE'
  | 'NOT_FOUND';

export interface ViewportSpec {
  name: string;
  width: number;
  height: number;
  isMobile: boolean;
}

export type PreAction =
  | { type: 'click'; selector: string }
  | { type: 'hover'; selector: string }
  | { type: 'focus'; selector: string }
  | { type: 'scroll'; selector: string }
  | { type: 'wait'; selector?: string; ms?: number }
  | { type: 'press'; key: string };

export interface PageOptions {
  /** Pre-actions run (in order) after load, to reach the state to inspect. */
  preActions?: PreAction[];
  /** Navigation wait condition. Default: "load". */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  /** Navigation / action timeout in ms. Default: 30000. */
  timeoutMs?: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElementRef {
  /** Human-readable label, e.g. `button.menu-item "Delete"`. */
  label: string;
  /** Short selector suitable for a CSS fix, e.g. `.card > .card-header`. */
  selector: string;
  /** Unique structural path used internally to re-find the node. */
  path: string;
  rect?: Rect;
  zIndex?: string;
  position?: string;
  /** Why this element creates a stacking context (null when it does not). */
  stackingContext?: string | null;
}

export interface StyleSnapshot {
  position: string;
  zIndex: string;
  pointerEvents: string;
  visibility: string;
  display: string;
  opacity: string;
  transform: string;
  isolation: string;
  contain: string;
  filter: string;
  willChange: string;
  mixBlendMode: string;
  overflow: string;
  backgroundColor: string;
}

export interface ElementDetails extends ElementRef {
  styles: StyleSnapshot;
  /** Ancestors with non-default stacking/visibility-related styles (closest first). */
  ancestors: Array<{ label: string; selector: string; path: string; styles: Partial<StyleSnapshot>; stackingContext: string | null }>;
}

export interface RuleDeclaration {
  /** Selector of the matched rule (or "style attribute"). */
  selector: string;
  property: string;
  value: string;
  important: boolean;
  /** Stylesheet URL, "inline <style>" document URL, or "style attribute". */
  source: string;
  inline: boolean;
  /** 1-based line in the source file (HTML file for inline <style>), when known. */
  line: number | null;
  origin: 'author' | 'user-agent' | 'inline' | 'other';
  /** True when this declaration is the one that wins the cascade for that property. */
  winning: boolean;
  /** Pseudo-element the rule applies to ("::after"), if any. */
  pseudo?: string;
}

export interface ResponsibleRule extends RuleDeclaration {
  /** Element the rule applies to. */
  element: string;
  /** Why this element matters for the diagnosis. */
  role: string;
}

export interface Fix {
  description: string;
  css?: string;
}

export interface PointProbe {
  name: string;
  x: number;
  y: number;
  elementFromPoint: string | null;
  hitsTarget: boolean;
  realClick: { receivedBy: string | null; event: string | null; reachedTarget: boolean } | null;
}

export interface StackEntry {
  index: number;
  label: string;
  selector: string;
  path: string;
  isTarget?: boolean;
  position: string;
  zIndex: string;
  pointerEvents: string;
  opacity: string;
  stackingContext: string | null;
}

export interface StackingBranch extends ElementRef {
  isStackingContext: boolean;
  reason: string | null;
  paintLayer: string;
}

export interface StackingAnalysis {
  targetChain: Array<{ label: string; selector: string; reason: string; zIndex: string }>;
  occluderChain: Array<{ label: string; selector: string; reason: string; zIndex: string }>;
  commonAncestor: { label: string; selector: string; reason: string };
  targetBranch: StackingBranch;
  occluderBranch: StackingBranch;
  occluderPaintsAbove: boolean;
  /** Plain-English explanation of why the occluder's branch paints above. */
  paintOrder: string;
  trapped: boolean;
}

export interface InvisibilityInfo {
  invisible: boolean;
  reasons: string[];
  pseudo: string | null;
}

export interface ViewportDiagnosis {
  viewport: ViewportSpec;
  verdict: Verdict;
  clickable: boolean;
  summary: string;
  explanation: string[];
  target?: ElementDetails | ElementRef;
  occluder?: (ElementDetails & { invisible: InvisibilityInfo; pseudo: string | null }) | null;
  stacking?: StackingAnalysis | null;
  responsibleRules: ResponsibleRule[];
  fixes: Fix[];
  warnings: string[];
  probes: PointProbe[];
  stack: StackEntry[];
  matchCount: number;
  scrolledIntoView?: boolean;
  screenshot?: string;
}

export interface InspectOptions extends PageOptions {
  /** Viewports to test. Default: ["desktop", "mobile"]. Accepts "desktop", "mobile", "tablet" or "WIDTHxHEIGHT". */
  viewports?: Array<string | ViewportSpec>;
  /** Write a PNG of the first blocked viewport (or the first viewport) with target/occluder outlined. */
  screenshot?: string;
  /** Skip the real mouse clicks (elementFromPoint only). Default: false. */
  noRealClick?: boolean;
}

export interface InspectResult {
  url: string;
  selector: string;
  verdict: Verdict;
  clickable: boolean;
  summary: string;
  /** Viewport whose diagnosis is surfaced as the main verdict (first blocked one). */
  primaryViewport: string;
  fixes: Fix[];
  viewports: ViewportDiagnosis[];
  screenshot?: string;
}

export interface StackAtPointResult {
  url: string;
  viewport: ViewportSpec;
  x: number;
  y: number;
  elements: Array<{
    index: number;
    label: string;
    selector: string;
    path: string;
    rect: Rect;
    position: string;
    zIndex: string;
    pointerEvents: string;
    opacity: string;
    visibility: string;
    stackingContext: string | null;
    paintLayer: string;
    visuallyInvisible: boolean;
    invisibleReasons: string[];
    stackingChain: Array<{ label: string; reason: string }>;
  }>;
}

export interface RulesResult {
  url: string;
  selector: string;
  element: string | null;
  matchCount: number;
  method: 'cdp' | 'cssom';
  rules: RuleDeclaration[];
  blockedStylesheets?: string[];
}

export interface InvisibleBlocker {
  occluder: ElementDetails;
  pseudo: string | null;
  reasons: string[];
  hitPoints: number;
  approxBlockedArea: number;
  samplePoint: { x: number; y: number };
  coveredElements: Array<{ label: string; selector: string; path: string; sample: { x: number; y: number } }>;
  /** Result of a real mouse click at samplePoint: who received it. */
  realClick: { receivedBy: string | null; reachedCoveredElement: boolean } | null;
  rules: RuleDeclaration[];
  fixes: Fix[];
}

export interface ScanViewportResult {
  viewport: ViewportSpec;
  step: number;
  gridPoints: number;
  blockers: InvisibleBlocker[];
  screenshot?: string;
}

export interface ScanOptions extends PageOptions {
  viewports?: Array<string | ViewportSpec>;
  /** Grid step in CSS pixels. Default: 24. */
  step?: number;
  /** PNG path; one file per viewport (suffix added when more than one). */
  screenshot?: string;
  noRealClick?: boolean;
}

export interface ScanResult {
  url: string;
  found: number;
  summary: string;
  viewports: ScanViewportResult[];
}
