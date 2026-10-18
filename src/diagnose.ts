import type {
  ElementDetails,
  ElementRef,
  InvisibilityInfo,
  PointProbe,
  ResponsibleRule,
  RuleDeclaration,
  StackEntry,
  StackingAnalysis,
  Verdict,
  ViewportDiagnosis,
  ViewportSpec,
} from './types.js';

// ---------- raw data returned by the in-page script ----------

export interface RawPrepare {
  status: 'PROBE' | 'NOT_FOUND' | 'INVISIBLE' | 'ZERO_SIZE' | 'OUTSIDE_VIEWPORT_OR_CLIPPED' | 'ERROR';
  error?: string;
  matchCount: number;
  target?: ElementRef;
  kind?: 'display' | 'visibility';
  culprit?: ElementRef;
  display?: string;
  clippedBy?: (ElementRef & { overflow: string }) | null;
  outsideViewport?: boolean;
  scrolled?: boolean;
  partiallyClippedBy?: ElementRef & { overflow: string };
  points?: Array<{ name: string; x: number; y: number }>;
  effectiveOpacity?: number;
  opacityCulprit?: ElementRef | null;
}

export interface RawBranch extends ElementRef {
  isStackingContext: boolean;
  reason: string | null;
  paintLayer: string;
  layerRank: number;
  layerZ: number;
}

export interface RawStacking {
  targetChain: StackingAnalysis['targetChain'];
  occluderChain: StackingAnalysis['occluderChain'];
  commonAncestor: StackingAnalysis['commonAncestor'];
  targetBranch: RawBranch;
  occluderBranch: RawBranch;
  occluderPaintsAbove: boolean;
  sameLayer: boolean;
  occluderLaterInDom: boolean;
  trapped: boolean;
  floating: ElementRef | null;
  stateSelector: string | null;
  branchSelector: string;
  occluderBranchSelector: string;
}

export interface RawAnalyze {
  probes: Array<Omit<PointProbe, 'realClick'>>;
  stack: StackEntry[];
  target: ElementDetails;
  disabled: boolean;
  pointerEventsCulprit?: ElementRef;
  occluder?: ElementDetails;
  occluderRelation?: 'ancestor' | 'other';
  occluderInvisibility?: InvisibilityInfo;
  occluderPseudo?: string | null;
  stacking?: RawStacking | null;
  passThroughOverlays: ElementRef[];
}

export interface RealClick {
  receivedBy: string | null;
  path: string | null;
  event: string | null;
  reachedTarget: boolean;
}

/** Fetches matched rules for an element path (CDP or CSSOM). */
export type RuleFetcher = (path: string, properties: string[], pseudo?: string | null) => Promise<RuleDeclaration[]>;

// ---------- helpers ----------

const q = (s: string) => `\`${s}\``;

function reasonProperties(reason: string | null | undefined): string[] {
  if (!reason) return [];
  const props = new Set<string>();
  if (/z-index/.test(reason)) props.add('z-index');
  const head = reason.split(':')[0].trim();
  const known = ['position', 'opacity', 'transform', 'translate', 'rotate', 'scale', 'perspective', 'filter',
    'backdrop-filter', 'clip-path', 'isolation', 'mix-blend-mode', 'will-change', 'contain', 'container-type'];
  if (known.includes(head)) props.add(head);
  if (head === 'mask-image') props.add('mask-image').add('mask');
  return [...props];
}

function zOf(b: RawBranch): number {
  return b.layerRank === 6 ? b.layerZ : 0;
}

function paintOrderText(s: RawStacking): string {
  const t = s.targetBranch;
  const o = s.occluderBranch;
  if (!s.occluderPaintsAbove) {
    return `By the static paint-order model ${t.label} should be on top; the occluder may be in the top layer, an iframe, or affected by a feature this tool does not model.`;
  }
  if (s.sameLayer) {
    const z = o.layerRank === 6 ? `z-index: ${o.layerZ}` : o.paintLayer;
    return `Both layers have the same paint level (${z}), so DOM order breaks the tie: ${o.label} comes later in the document and paints on top.`;
  }
  if (t.layerRank === 6 && o.layerRank === 6) return `z-index ${o.layerZ} (${o.label}) beats z-index ${t.layerZ} (${t.label}).`;
  return `${o.label} is in the ${o.paintLayer}, which paints above the ${t.paintLayer} of ${t.label}.`;
}

function toStacking(s: RawStacking): StackingAnalysis {
  const strip = (b: RawBranch) => ({
    label: b.label, selector: b.selector, path: b.path, rect: b.rect, zIndex: b.zIndex, position: b.position,
    stackingContext: b.stackingContext, isStackingContext: b.isStackingContext, reason: b.reason, paintLayer: b.paintLayer,
  });
  return {
    targetChain: s.targetChain,
    occluderChain: s.occluderChain,
    commonAncestor: s.commonAncestor,
    targetBranch: strip(s.targetBranch),
    occluderBranch: strip(s.occluderBranch),
    occluderPaintsAbove: s.occluderPaintsAbove,
    paintOrder: paintOrderText(s),
    trapped: s.trapped,
  };
}

async function collect(
  fetch: RuleFetcher,
  el: ElementRef | null | undefined,
  props: string[],
  role: string,
  pseudo?: string | null,
): Promise<ResponsibleRule[]> {
  if (!el || !props.length) return [];
  const decls = await fetch(el.path, props, pseudo);
  const winning = decls.filter((d) => d.winning);
  const authored = winning.filter((d) => d.origin !== 'user-agent');
  const chosen = authored.length ? authored : winning;
  const label = pseudo ? `${el.label}${pseudo}` : el.label;
  return chosen.map((d) => ({ ...d, element: label, role }));
}

function dedupeRules(rules: ResponsibleRule[]): ResponsibleRule[] {
  const seen = new Set<string>();
  return rules.filter((r) => {
    const k = `${r.element}|${r.selector}|${r.property}|${r.source}|${r.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function base(viewport: ViewportSpec, matchCount: number): Omit<ViewportDiagnosis, 'verdict' | 'clickable' | 'summary'> {
  return { viewport, explanation: [], responsibleRules: [], fixes: [], warnings: [], probes: [], stack: [], matchCount };
}

// ---------- early verdicts (no hit test possible) ----------

export async function diagnoseEarly(
  viewport: ViewportSpec,
  selector: string,
  p: RawPrepare,
  fetch: RuleFetcher,
): Promise<ViewportDiagnosis> {
  const d = base(viewport, p.matchCount);
  const t = p.target;
  if (p.status === 'NOT_FOUND') {
    return {
      ...d,
      verdict: 'NOT_FOUND',
      clickable: false,
      summary: `No element matches ${q(selector)}.`,
      explanation: [
        `document.querySelectorAll(${JSON.stringify(selector)}) returned 0 elements in the ${viewport.name} viewport.`,
        'If the element only exists after an interaction (open menu, modal, tab), add pre-actions such as click:<toggle> and wait:<selector>.',
      ],
      fixes: [{ description: 'Check the selector, or add pre-actions that bring the page into the state where the element exists.' }],
    };
  }
  if (p.status === 'INVISIBLE' && p.culprit && t) {
    const prop = p.kind === 'display' ? 'display' : 'visibility';
    const self = p.culprit.path === t.path;
    const rules = await collect(fetch, p.culprit, [prop], self ? 'target' : 'hidden ancestor');
    const fixValue = prop === 'display' ? 'block /* or the intended display value */' : 'visible';
    return {
      ...d,
      target: t,
      verdict: 'INVISIBLE',
      clickable: false,
      summary: `${t.label} is not rendered: ${prop}: ${prop === 'display' ? 'none' : 'hidden'} on ${self ? 'the element itself' : p.culprit.label}.`,
      explanation: [
        prop === 'display'
          ? `${self ? t.label : `Its ancestor ${p.culprit.label}`} has display: none, so the element generates no box and cannot be hit.`
          : `${self ? t.label : `Its ancestor ${p.culprit.label}`} has visibility: hidden (inherited), so it is skipped by hit testing.`,
      ],
      responsibleRules: rules,
      fixes: [
        { description: `Show ${p.culprit.label} in the state where the target should be clickable.`, css: `${p.culprit.selector} {\n  ${prop}: ${fixValue};\n}` },
        { description: 'If it is only shown after an interaction, run that interaction first (pre-actions) and inspect again.' },
      ],
    };
  }
  if (p.status === 'ZERO_SIZE' && t) {
    const rules = await collect(fetch, t, ['display', 'width', 'height', 'position', 'overflow', 'content'], 'target');
    return {
      ...d,
      target: t,
      verdict: 'ZERO_SIZE',
      clickable: false,
      summary: `${t.label} has a zero-size box (${t.rect?.width ?? 0}x${t.rect?.height ?? 0}).`,
      explanation: [
        `The element's border box is ${t.rect?.width ?? 0}x${t.rect?.height ?? 0}px (display: ${p.display}), so there is no area to click.`,
        'Common causes: empty element with no padding, width/height: 0, an absolutely positioned child sizing nothing, display: contents, or content that has not loaded.',
      ],
      responsibleRules: rules,
      fixes: [{ description: 'Give the element an intrinsic size (content, padding, or explicit width/height), or make the inner clickable child the actual target.' }],
    };
  }
  if (p.status === 'OUTSIDE_VIEWPORT_OR_CLIPPED' && t) {
    if (p.clippedBy) {
      const c = p.clippedBy;
      const rules = [
        ...(await collect(fetch, c, ['overflow', 'overflow-x', 'overflow-y', 'contain', 'height', 'max-height', 'width'], 'clipping ancestor')),
        ...(await collect(fetch, t, ['position', 'top', 'left', 'right', 'bottom', 'inset', 'transform'], 'target')),
      ];
      return {
        ...d,
        target: t,
        verdict: 'OUTSIDE_VIEWPORT_OR_CLIPPED',
        clickable: false,
        summary: `${t.label} is clipped away by ${c.label} (overflow: ${c.overflow}).`,
        explanation: [
          `The target box lies entirely outside the padding box of ${c.label}, which has overflow: ${c.overflow}. Overflowing content is clipped and cannot be hit.`,
          'An absolutely positioned element is only clipped by overflow on ancestors at or below its containing block; here the clipping ancestor is in that chain.',
        ],
        responsibleRules: dedupeRules(rules),
        fixes: [
          { description: `Let the content overflow if it is meant to be visible outside ${c.selector}.`, css: `${c.selector} {\n  overflow: visible;\n}` },
          { description: `Or keep the clipping and render the element outside ${c.selector} (e.g. a popover/portal), or position it inside the visible area.` },
          { description: 'Or make the container scrollable (overflow: auto) if the content should be reachable by scrolling.' },
        ],
      };
    }
    const rules = await collect(fetch, t, ['position', 'top', 'left', 'right', 'bottom', 'inset', 'transform', 'margin'], 'target');
    return {
      ...d,
      target: t,
      verdict: 'OUTSIDE_VIEWPORT_OR_CLIPPED',
      clickable: false,
      summary: `${t.label} is outside the viewport even after scrolling it into view.`,
      explanation: [
        `The target box (${JSON.stringify(t.rect)}) does not intersect the ${viewport.width}x${viewport.height} viewport after scrollIntoView(), e.g. a fixed element positioned off-screen or negative offsets.`,
      ],
      responsibleRules: rules,
      fixes: [{ description: 'Check the offsets/transform that move the element off-screen in this viewport (media queries often differ between desktop and mobile).' }],
    };
  }
  throw new Error(`Unexpected prepare status ${p.status}`);
}

// ---------- full diagnosis after hit testing ----------

export async function diagnoseProbe(
  viewport: ViewportSpec,
  p: RawPrepare,
  a: RawAnalyze,
  clicks: RealClick[],
  fetch: RuleFetcher,
): Promise<ViewportDiagnosis> {
  const d = base(viewport, p.matchCount);
  const t = a.target;
  d.target = t;
  d.stack = a.stack;
  d.scrolledIntoView = !!p.scrolled;
  d.probes = a.probes.map((pr, i) => ({
    ...pr,
    realClick: clicks[i] ? { receivedBy: clicks[i].receivedBy, event: clicks[i].event, reachedTarget: clicks[i].reachedTarget } : null,
  }));

  const usedReal = clicks.length > 0;
  const reached = d.probes.filter((pr) => (usedReal ? pr.realClick?.reachedTarget : pr.hitsTarget)).length;
  const centerOk = usedReal ? !!clicks[0]?.reachedTarget : a.probes[0].hitsTarget;

  // ----- warnings -----
  if (p.matchCount > 1) d.warnings.push(`Selector matched ${p.matchCount} elements; inspected the first one.`);
  if (p.scrolled) d.warnings.push('The target was outside the viewport and was scrolled into view first.');
  if (p.partiallyClippedBy) d.warnings.push(`Part of the target is clipped by ${p.partiallyClippedBy.label} (overflow: ${p.partiallyClippedBy.overflow}); only the visible part was probed.`);
  if (a.disabled) d.warnings.push('The target is :disabled; browsers do not dispatch click events to disabled form controls.');
  if (centerOk && reached < d.probes.length) {
    const bad = d.probes.filter((pr) => !(usedReal ? pr.realClick?.reachedTarget : pr.hitsTarget));
    d.warnings.push(`Partially covered: ${bad.length}/${d.probes.length} probe points do not reach the target (${bad.map((b) => `${b.name} -> ${(usedReal ? b.realClick?.receivedBy : b.elementFromPoint) ?? 'nothing'}`).join('; ')}).`);
  }
  for (const o of a.passThroughOverlays) {
    d.warnings.push(`${o.label} paints over the target but has pointer-events: none, so clicks pass through it (visual overlap only).`);
  }
  if (usedReal) {
    const disagree = d.probes.filter((pr) => pr.realClick && pr.realClick.reachedTarget !== pr.hitsTarget);
    if (disagree.length) d.warnings.push(`elementFromPoint and the real mouse click disagree at ${disagree.map((x) => x.name).join(', ')}; the real click is authoritative.`);
  }

  // ----- pointer-events: none -----
  if (a.pointerEventsCulprit) {
    const c = a.pointerEventsCulprit;
    const self = c.path === t.path;
    const hit = clicks[0]?.receivedBy ?? a.probes[0].elementFromPoint ?? 'nothing';
    d.responsibleRules = await collect(fetch, c, ['pointer-events'], self ? 'target' : 'ancestor with pointer-events: none');
    const ruleSel = d.responsibleRules[0]?.selector;
    return {
      ...d,
      verdict: 'POINTER_EVENTS_NONE',
      clickable: false,
      summary: `${t.label} ignores the mouse: computed pointer-events: none${self ? '' : `, inherited from ${c.label}`}.`,
      explanation: [
        `${t.label} has computed pointer-events: none${self ? '' : ` (pointer-events is inherited; it is set on ${c.label})`}.`,
        `Hit testing skips such elements, so the click goes to whatever is behind it: ${hit}.`,
      ],
      fixes: [
        { description: `Re-enable pointer events on the target only (a descendant can opt back in even when an ancestor has pointer-events: none).`, css: `${t.selector} {\n  pointer-events: auto;\n}` },
        ...(self
          ? []
          : [{ description: `Or, if the whole region should be interactive, remove pointer-events: none from ${ruleSel ? q(ruleSel) : c.selector}.` }]),
      ],
    };
  }

  // ----- clickable -----
  if (centerOk) {
    if ((p.effectiveOpacity ?? 1) <= 0.02) {
      const c = p.opacityCulprit ?? t;
      d.responsibleRules = await collect(fetch, c, ['opacity'], c.path === t.path ? 'target' : 'transparent ancestor');
      return {
        ...d,
        verdict: 'INVISIBLE',
        clickable: true,
        summary: `${t.label} receives clicks but is invisible (effective opacity ${p.effectiveOpacity}).`,
        explanation: [
          `opacity: 0${c.path === t.path ? '' : ` on ${c.label}`} makes the element fully transparent, but transparent elements still take part in hit testing.`,
          'Users cannot see it, yet it intercepts clicks in its area. If it is a hidden control, use visibility: hidden or display: none instead.',
        ],
        fixes: [
          { description: 'If it should be hidden, remove it from hit testing too.', css: `${c.selector} {\n  visibility: hidden; /* or display: none / pointer-events: none */\n}` },
          { description: 'If it should be visible, fix the opacity in the state where it should appear.' },
        ],
      };
    }
    return {
      ...d,
      verdict: 'OK',
      clickable: true,
      summary: `${t.label} is clickable: ${reached}/${d.probes.length} probe points reach it${usedReal ? ' with a real mouse click' : ''}.`,
      explanation: [`A ${usedReal ? 'real mouse click' : 'hit test'} at the center of the target reaches the target itself.`],
    };
  }

  // ----- blocked -----
  const o = a.occluder;
  if (!o) {
    return {
      ...d,
      verdict: 'COVERED_BY_POSITIONED_ELEMENT',
      clickable: false,
      summary: `Clicking ${t.label} does not deliver any click event.`,
      explanation: ['No element received the click at the target center. The target may be disabled, inside a cross-origin iframe, or removed on mousedown.'],
    };
  }
  const inv: InvisibilityInfo = a.occluderInvisibility ?? { invisible: false, reasons: [], pseudo: null };
  const pseudo = a.occluderPseudo ?? null;
  d.occluder = { ...o, invisible: inv, pseudo };
  const oLabel = pseudo ? `${o.label}${pseudo}` : o.label;
  const invisibleNote = inv.invisible
    ? `The element on top is visually invisible (${inv.reasons.join('; ')}): users can see the target, but clicks land on ${oLabel}.`
    : null;

  // Ancestor wins the hit test: a positioned ::before/::after overlay, or the target is painted below its ancestor.
  if (a.occluderRelation === 'ancestor') {
    if (pseudo) {
      d.responsibleRules = dedupeRules(
        await collect(fetch, o, ['content', 'position', 'inset', 'top', 'right', 'bottom', 'left', 'width', 'height', 'z-index', 'background', 'background-color', 'opacity', 'pointer-events'], 'covering pseudo-element', pseudo),
      );
      return {
        ...d,
        verdict: inv.invisible ? 'INVISIBLE_OCCLUDER' : 'COVERED_BY_POSITIONED_ELEMENT',
        clickable: false,
        summary: `Clicking ${t.label} hits ${oLabel}, a positioned pseudo-element of its ancestor${inv.invisible ? ' that paints nothing' : ''}.`,
        explanation: [
          `${o.label} has a ${pseudo} pseudo-element with position: absolute/fixed that is stretched over its content.`,
          `Positioned boxes paint after (above) in-flow content, so ${pseudo} sits on top of ${t.label} and receives the click (events from a pseudo-element are reported on its owner, ${o.label}).`,
          ...(invisibleNote ? [invisibleNote] : []),
        ],
        fixes: [
          { description: `Let clicks pass through the decorative pseudo-element.`, css: `${o.selector}${pseudo} {\n  pointer-events: none;\n}` },
          { description: `Or lift the target above it (positioned with a z-index higher than the pseudo-element's).`, css: `${t.selector} {\n  position: relative;\n  z-index: 1;\n}` },
        ],
      };
    }
    d.responsibleRules = dedupeRules([
      ...(await collect(fetch, t, ['position', 'z-index'], 'target')),
      ...(await collect(fetch, o, ['position', 'z-index'], 'ancestor')),
    ]);
    return {
      ...d,
      verdict: inv.invisible ? 'INVISIBLE_OCCLUDER' : 'COVERED_BY_POSITIONED_ELEMENT',
      clickable: false,
      summary: `Clicking ${t.label} hits its own ancestor ${o.label}.`,
      explanation: [
        `The target is painted below its ancestor ${o.label} (typically a negative z-index on the target or one of its ancestors), so the ancestor wins the hit test.`,
      ],
      fixes: [{ description: 'Avoid negative z-index on the target; give the target a non-negative z-index inside its stacking context.', css: `${t.selector} {\n  z-index: 0;\n}` }],
    };
  }

  const s = a.stacking;
  const stacking = s ? toStacking(s) : null;
  d.stacking = stacking;
  const occBranch = s?.occluderBranch;
  const tBranch = s?.targetBranch;
  const zO = occBranch ? zOf(occBranch) : 0;
  const newZ = Math.max(zO + 1, 1);
  const floatingZ = s?.floating && s.floating.zIndex && s.floating.zIndex !== 'auto' ? Number(s.floating.zIndex) : null;
  const trapMatters =
    !!s?.trapped && (!occBranch || occBranch.layerRank < 6 || (floatingZ != null && floatingZ > zO) || !inv.invisible);

  let verdict: Verdict;
  if (s && s.trapped && trapMatters) verdict = 'COVERED_BY_SIBLING_STACKING_CONTEXT';
  else if (inv.invisible) verdict = 'INVISIBLE_OCCLUDER';
  else verdict = 'COVERED_BY_POSITIONED_ELEMENT';

  // ----- responsible rules -----
  const rules: ResponsibleRule[] = [];
  if (s && tBranch && occBranch) {
    rules.push(...(await collect(fetch, tBranch, ['position', 'z-index', ...reasonProperties(tBranch.reason)], 'layer containing the target')));
    rules.push(...(await collect(fetch, occBranch, ['position', 'z-index', ...reasonProperties(occBranch.reason)], 'layer containing the occluder')));
    if (s.floating && s.floating.path !== tBranch.path) {
      rules.push(...(await collect(fetch, s.floating, ['position', 'z-index'], 'positioned element trapped in the layer')));
    }
  }
  if (inv.invisible && o.path !== occBranch?.path) {
    rules.push(...(await collect(fetch, o, ['opacity', 'background', 'background-color', 'position', 'inset', 'top', 'left', 'width', 'height', 'z-index', 'pointer-events'], 'invisible occluder')));
  } else if (inv.invisible) {
    rules.push(...(await collect(fetch, o, ['opacity', 'background', 'background-color', 'inset', 'width', 'height', 'pointer-events'], 'invisible occluder')));
  }
  d.responsibleRules = dedupeRules(rules);

  const tBranchZRule = d.responsibleRules.find((r) => r.role === 'layer containing the target' && r.property === 'z-index');
  const tBranchReasonRule = tBranch?.reason
    ? d.responsibleRules.find((r) => r.role === 'layer containing the target' && reasonProperties(tBranch.reason).includes(r.property) && r.property !== 'position')
    : undefined;

  if (verdict === 'COVERED_BY_SIBLING_STACKING_CONTEXT' && s && tBranch && occBranch) {
    const fl = s.floating;
    const parentSel = s.branchSelector;
    const sel = parentSel + (s.stateSelector ? `:has(${s.stateSelector})` : '');
    const needsPos = tBranch.position === 'static';
    d.explanation = [
      `${t.label} is inside ${fl && fl.path !== tBranch.path ? `${fl.label} (z-index: ${fl.zIndex}), which lives in ` : ''}the stacking context created by ${tBranch.label} (${tBranch.reason}).`,
      `A stacking context is a sealed layer: z-index values inside it only order elements within ${tBranch.label}. Against the rest of the page the whole layer paints at ${tBranch.label}'s own level (${tBranch.paintLayer}${tBranch.layerRank === 6 ? `, z-index ${tBranch.layerZ}` : ''}).`,
      `${occBranch.label}${occBranch.reason ? ` (${occBranch.reason})` : ''} is a sibling layer in the same parent context (${s.commonAncestor.label}). ${paintOrderText(s)}`,
      `So ${oLabel} paints over the target and receives the click.`,
      ...(invisibleNote ? [invisibleNote] : []),
    ];
    d.fixes = [
      {
        description: `Raise the layer that contains the target${s.stateSelector ? ' only while it is open' : ''}: give ${tBranch.selector} a z-index above its sibling layer (${occBranch.label}${occBranch.layerRank === 6 ? `, z-index ${occBranch.layerZ}` : ''}).`,
        css: `${sel} {\n${needsPos ? '  position: relative;\n' : ''}  z-index: ${newZ};\n}`,
      },
    ];
    if (tBranchZRule && tBranchZRule.origin === 'author') {
      d.fixes.push({
        description: `Or stop creating a layer per child: if the elements matched by ${q(tBranchZRule.selector)} do not need their own stacking context, remove z-index: ${tBranchZRule.value} from that rule (position: relative alone does not create one). Then ${fl ? `${fl.label}'s z-index (${fl.zIndex})` : 'the inner z-index'} competes directly in ${s.commonAncestor.label}.`,
      });
    } else if (tBranchReasonRule) {
      d.fixes.push({
        description: `Or move ${tBranchReasonRule.property}: ${tBranchReasonRule.value} (from ${q(tBranchReasonRule.selector)}) off ${tBranch.label} onto an inner element, so it no longer creates a stacking context around the floating content.`,
      });
    }
    d.fixes.push({
      description: `Or render ${fl ? fl.selector : 'the floating element'} outside the trapping layer: the HTML Popover API (\`popover\` attribute, rendered in the top layer) or a portal appended to <body>.`,
    });
    if (fl && fl.zIndex && fl.zIndex !== 'auto') {
      d.warnings.push(`Raising z-index on ${fl.selector} (e.g. 9999) will not help: it cannot escape the stacking context of ${tBranch.label}.`);
    }
    return { ...d, verdict, clickable: false, summary: `Clicking ${t.label} lands on ${oLabel}: the target is trapped in ${tBranch.label}'s stacking context and a sibling layer paints on top.` };
  }

  if (verdict === 'INVISIBLE_OCCLUDER') {
    d.explanation = [
      `${oLabel} is on top of ${t.label} at the click point, but it is visually invisible: ${inv.reasons.join('; ')}.`,
      'Invisible boxes still take part in hit testing, so they silently eat clicks meant for what you see underneath.',
      ...(s && occBranch ? [`It wins because ${paintOrderText(s)}`] : []),
    ];
    const occSel = o.selector;
    d.fixes = [
      { description: `If ${o.label} is a leftover/closed overlay, take it out of the page while inactive.`, css: `${occSel} {\n  display: none; /* or visibility: hidden while closed */\n}` },
      { description: `If it is a layout wrapper or decoration, let clicks pass through it (interactive children can opt back in with pointer-events: auto).`, css: `${occSel} {\n  pointer-events: none;\n}` },
    ];
    if (tBranch) {
      d.fixes.push({
        description: `Or lift the target's layer above it.`,
        css: `${tBranch.selector} {\n  position: relative;\n  z-index: ${newZ};\n}`,
      });
    }
    return { ...d, verdict, clickable: false, summary: `Clicking ${t.label} lands on ${oLabel}, an invisible element on top of it.` };
  }

  // COVERED_BY_POSITIONED_ELEMENT
  d.explanation = [
    `${oLabel} covers ${t.label} at the click point${occBranch && occBranch.path !== o.path ? ` (it belongs to the layer ${occBranch.label})` : ''}.`,
    ...(s ? [paintOrderText(s)] : []),
  ];
  d.fixes = [];
  if (tBranch) {
    d.fixes.push({
      description: `Lift the target's layer above the occluder (${occBranch?.layerRank === 6 ? `z-index ${occBranch.layerZ}` : occBranch?.paintLayer ?? 'occluder'}).`,
      css: `${tBranch.selector} {\n  position: relative;\n  z-index: ${newZ};\n}`,
    });
  }
  d.fixes.push({ description: `If ${o.label} is decorative and should not catch clicks, let them pass through it.`, css: `${(occBranch ?? o).selector} {\n  pointer-events: none;\n}` });
  d.fixes.push({ description: 'Or change the layout so they no longer overlap (e.g. offset content below a sticky/fixed header with padding or scroll-margin-top).' });
  return { ...d, verdict, clickable: false, summary: `Clicking ${t.label} lands on ${oLabel}, which paints above it.` };
}

export function isBlocked(v: Verdict): boolean {
  return v !== 'OK';
}
