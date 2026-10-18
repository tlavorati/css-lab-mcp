import pc from 'picocolors';
import { formatSource } from './rules.js';
import type { InspectResult, RulesResult, ScanResult, StackAtPointResult, ViewportDiagnosis, RuleDeclaration } from './types.js';

const indent = (s: string, n: number) => s.split('\n').map((l) => ' '.repeat(n) + l).join('\n');

function ruleLine(r: RuleDeclaration & { element?: string }): string {
  const decl = `${r.property}: ${r.value}${r.important ? ' !important' : ''}`;
  const where = pc.dim(formatSource(r));
  const on = r.element ? pc.dim(` on ${r.element}`) : '';
  return `${pc.cyan(r.selector)} { ${decl} }  ${where}${on}`;
}

function viewportBlock(d: ViewportDiagnosis, verbose: boolean): string {
  const lines: string[] = [];
  const vp = `${d.viewport.name} ${d.viewport.width}x${d.viewport.height}`;
  const head = d.verdict === 'OK' ? pc.green(pc.bold('OK')) : pc.red(pc.bold('BLOCKED'));
  lines.push(`${head} ${pc.bold(d.verdict)} ${pc.dim(`(${vp})`)}`);
  lines.push(indent(d.summary, 2));
  if (d.verdict !== 'OK' && d.explanation.length) {
    lines.push(pc.bold('  Why'));
    for (const e of d.explanation) lines.push(indent(`- ${e}`, 4));
  }
  if (d.stacking && d.verdict !== 'OK') {
    const s = d.stacking;
    lines.push(pc.bold('  Stacking'));
    lines.push(indent(`common context: ${s.commonAncestor.label} (${s.commonAncestor.reason})`, 4));
    lines.push(indent(`target layer:   ${s.targetBranch.label}${s.targetBranch.reason ? ` (${s.targetBranch.reason})` : ''}`, 4));
    lines.push(indent(`occluder layer: ${s.occluderBranch.label}${s.occluderBranch.reason ? ` (${s.occluderBranch.reason})` : ''}`, 4));
  }
  if (d.responsibleRules.length) {
    lines.push(pc.bold('  Responsible CSS'));
    for (const r of d.responsibleRules) lines.push(indent(ruleLine(r), 4));
  }
  if (d.fixes.length) {
    lines.push(pc.bold('  Fix'));
    d.fixes.forEach((f, i) => {
      lines.push(indent(`${i + 1}. ${f.description}`, 4));
      if (f.css) lines.push(pc.yellow(indent(f.css, 7)));
    });
  }
  if (d.probes.length) {
    const real = d.probes.some((p) => p.realClick);
    const ok = d.probes.filter((p) => (real ? p.realClick?.reachedTarget : p.hitsTarget)).length;
    const center = d.probes[0];
    const who = real ? center.realClick?.receivedBy : center.elementFromPoint;
    lines.push(pc.dim(`  Hit test: ${ok}/${d.probes.length} points reach the target; ${real ? 'real click' : 'elementFromPoint'} at center -> ${who ?? 'nothing'}`));
  }
  if (verbose && d.stack.length) {
    lines.push(pc.dim('  Stack at center (top first):'));
    for (const e of d.stack) {
      lines.push(pc.dim(indent(`${e.index}. ${e.isTarget ? pc.green(e.label) : e.label}  pos=${e.position} z=${e.zIndex}${e.pointerEvents === 'none' ? ' pe=none' : ''}${e.stackingContext ? ` [${e.stackingContext}]` : ''}`, 4)));
    }
  }
  for (const w of d.warnings) lines.push(pc.yellow(indent(`! ${w}`, 2)));
  if (d.screenshot) lines.push(pc.dim(`  Screenshot: ${d.screenshot}`));
  return lines.join('\n');
}

export function formatInspect(r: InspectResult, verbose = false): string {
  const out: string[] = [pc.dim(`${r.selector} @ ${r.url}`)];
  for (const d of r.viewports) out.push(viewportBlock(d, verbose));
  return out.join('\n\n');
}

export function formatStack(r: StackAtPointResult): string {
  const out = [pc.dim(`Elements at (${r.x}, ${r.y}) in ${r.viewport.name} ${r.viewport.width}x${r.viewport.height}, topmost first:`)];
  for (const e of r.elements) {
    const inv = e.visuallyInvisible ? pc.red(' [invisible]') : '';
    out.push(`${String(e.index).padStart(2)}. ${pc.bold(e.label)}${inv}  ${pc.dim(`pos=${e.position} z=${e.zIndex} opacity=${e.opacity}${e.pointerEvents === 'none' ? ' pe=none' : ''}`)}`);
    if (e.stackingContext) out.push(pc.dim(`      creates stacking context: ${e.stackingContext}`));
    if (e.visuallyInvisible) out.push(pc.dim(`      invisible: ${e.invisibleReasons.join('; ')}`));
  }
  if (!r.elements.length) out.push('  (nothing at this point)');
  return out.join('\n');
}

export function formatRules(r: RulesResult): string {
  if (!r.element) return pc.red(`No element matches ${r.selector}`);
  const out = [pc.dim(`${r.element} (${r.matchCount} match${r.matchCount === 1 ? '' : 'es'}, via ${r.method.toUpperCase()})`)];
  if (!r.rules.length) out.push('  No matching declarations for the requested properties.');
  for (const d of r.rules) {
    const mark = d.winning ? pc.green('*') : ' ';
    const line = ruleLine(d);
    out.push(`${mark} ${d.winning ? line : pc.strikethrough(pc.dim(line))}${d.origin === 'user-agent' ? pc.dim(' (user agent)') : ''}`);
  }
  out.push(pc.dim('  * = winning declaration'));
  if (r.blockedStylesheets?.length) out.push(pc.yellow(`  ! Cross-origin stylesheets not readable via CSSOM: ${r.blockedStylesheets.join(', ')}`));
  return out.join('\n');
}

export function formatScan(r: ScanResult): string {
  const out = [pc.dim(r.url)];
  for (const v of r.viewports) {
    const head = v.blockers.length ? pc.red(pc.bold(`${v.blockers.length} invisible blocker(s)`)) : pc.green(pc.bold('clean'));
    out.push(`${head} ${pc.dim(`(${v.viewport.name} ${v.viewport.width}x${v.viewport.height}, ${v.gridPoints} points every ${v.step}px)`)}`);
    v.blockers.forEach((b, i) => {
      const sel = b.occluder.selector + (b.pseudo ?? '');
      const rc = b.occluder.rect;
      out.push(`  ${i + 1}. ${pc.bold(sel)} ${pc.dim(`(${b.occluder.label}${b.pseudo ?? ''}${rc ? `, ${rc.width}x${rc.height} at ${rc.x},${rc.y}` : ''})`)}`);
      out.push(`     ${pc.dim('why invisible:')} ${b.reasons.join('; ')}`);
      out.push(`     ${pc.dim('covers:')} ${b.coveredElements.map((c) => c.label).join(', ')}`);
      if (b.realClick) out.push(`     ${pc.dim('real click at')} (${b.samplePoint.x}, ${b.samplePoint.y}) ${pc.dim('->')} ${b.realClick.receivedBy ?? 'nothing'}`);
      for (const d of b.rules.slice(0, 6)) out.push(`     ${ruleLine(d)}`);
      const f = b.fixes[0];
      if (f?.css) out.push(pc.yellow(indent(f.css, 5)));
    });
    if (v.screenshot) out.push(pc.dim(`  Screenshot: ${v.screenshot}`));
  }
  out.push(r.summary);
  return out.join('\n');
}
