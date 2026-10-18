/**
 * Code injected into the inspected page. It is kept as a plain JavaScript string
 * (not a serialized TS function) so that no bundler/transpiler helper can leak
 * into the browser context. It installs `window.__cssLab__` once per document.
 *
 * Everything here runs inside the real rendering engine: hit testing, computed
 * styles and stacking-context detection all come from Chromium itself.
 */
export const PAGE_SCRIPT = String.raw`
(function () {
  if (window.__cssLab__) return;

  var OPEN_CLASS_RE = /^(is-)?(open|opened|show|shown|active|expanded|visible)$/;
  var INTERACTIVE = 'a[href], button, input:not([type="hidden"]), select, textarea, label, summary, ' +
    '[role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"], ' +
    '[role="option"], [onclick], [tabindex]:not([tabindex="-1"])';
  var REPLACED = { IMG: 1, VIDEO: 1, CANVAS: 1, SVG: 1, IFRAME: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1,
    BUTTON: 1, OBJECT: 1, EMBED: 1, PICTURE: 1, METER: 1, PROGRESS: 1 };
  var LAYER_NAMES = { 1: 'negative z-index layer', 2: 'in-flow block layer', 3: 'float layer',
    4: 'inline layer', 5: 'positioned layer (z-index auto/0)', 6: 'positive z-index layer', 9: 'top layer' };

  var state = { target: null, clicks: [], down: null, click: null, handler: null, marks: [] };

  function cs(el, pseudo) { return getComputedStyle(el, pseudo || null); }
  function parentEl(el) {
    if (el.parentElement) return el.parentElement;
    var root = el.getRootNode && el.getRootNode();
    return root && root.host ? root.host : null;
  }
  function contains(a, b) {
    var n = b;
    while (n) { if (n === a) return true; n = parentEl(n); }
    return false;
  }
  function round(n) { return Math.round(n * 10) / 10; }
  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { x: round(r.left), y: round(r.top), width: round(r.width), height: round(r.height) };
  }
  function shortText(el) {
    var t = (el.textContent || '').trim().replace(/\s+/g, ' ');
    return t.length > 28 ? t.slice(0, 27) + '…' : t;
  }
  function label(el) {
    if (!el || el.nodeType !== 1) return null;
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    var cls = Array.prototype.slice.call(el.classList, 0, 3);
    if (cls.length) s += '.' + cls.join('.');
    if (!el.id && el !== document.body && el !== document.documentElement) {
      try {
        var same = document.querySelectorAll(el.tagName.toLowerCase() + Array.prototype.map.call(el.classList, function (c) { return '.' + CSS.escape(c); }).join(''));
        if (same.length > 1) s += '[' + (Array.prototype.indexOf.call(same, el) + 1) + '/' + same.length + ']';
      } catch (e) {}
    }
    if (!el.id && el.children.length <= 1) {
      var t = shortText(el);
      if (t) s += ' "' + t + '"';
    }
    return s;
  }
  function cssPath(el) {
    var parts = [];
    var n = el;
    while (n && n.nodeType === 1) {
      if (n === document.documentElement) { parts.unshift('html'); break; }
      if (n.id) {
        var idSel = '#' + CSS.escape(n.id);
        try { if (document.querySelectorAll(idSel).length === 1) { parts.unshift(idSel); break; } } catch (e) {}
      }
      var p = n.parentElement;
      var tag = n.tagName.toLowerCase();
      if (!p) { parts.unshift(tag); break; }
      parts.unshift(tag + ':nth-child(' + (Array.prototype.indexOf.call(p.children, n) + 1) + ')');
      n = p;
    }
    return parts.join(' > ');
  }
  function meaningfulClass(el) {
    for (var i = 0; i < el.classList.length; i++) {
      if (!OPEN_CLASS_RE.test(el.classList[i])) return el.classList[i];
    }
    return null;
  }
  function simpleSel(el, preferClass) {
    var c = meaningfulClass(el);
    if (preferClass && c) return '.' + CSS.escape(c);
    if (el.id) return '#' + CSS.escape(el.id);
    if (c) return '.' + CSS.escape(c);
    return el.tagName.toLowerCase();
  }
  function shortSelector(el) {
    if (el === document.documentElement) return 'html';
    if (el === document.body) return 'body';
    if (el.id) return '#' + CSS.escape(el.id);
    var self = simpleSel(el, true);
    var p = parentEl(el);
    if (p && p !== document.body && p !== document.documentElement) return simpleSel(p, true) + ' > ' + self;
    return self;
  }
  function stateSelector(el, stop) {
    var n = el;
    while (n && n !== stop) {
      for (var i = 0; i < n.classList.length; i++) {
        if (OPEN_CLASS_RE.test(n.classList[i])) {
          var mc = meaningfulClass(n);
          return (mc ? '.' + CSS.escape(mc) : n.tagName.toLowerCase()) + '.' + CSS.escape(n.classList[i]);
        }
      }
      if (n.hasAttribute && n.hasAttribute('open')) {
        var m2 = meaningfulClass(n);
        return (m2 ? '.' + CSS.escape(m2) : n.tagName.toLowerCase()) + '[open]';
      }
      n = parentEl(n);
    }
    if (stop && stop.querySelector && stop.querySelector('[aria-expanded="true"]')) return '[aria-expanded="true"]';
    return null;
  }

  function styles(el) {
    var s = cs(el);
    return {
      position: s.position, zIndex: s.zIndex, pointerEvents: s.pointerEvents, visibility: s.visibility,
      display: s.display, opacity: s.opacity, transform: s.transform, isolation: s.isolation,
      contain: s.contain, filter: s.filter, willChange: s.willChange, mixBlendMode: s.mixBlendMode,
      overflow: s.overflowX === s.overflowY ? s.overflowX : s.overflowX + ' ' + s.overflowY,
      backgroundColor: s.backgroundColor
    };
  }
  var DEFAULTS = { position: 'static', zIndex: 'auto', pointerEvents: 'auto', visibility: 'visible',
    opacity: '1', transform: 'none', isolation: 'auto', contain: 'none', filter: 'none', willChange: 'auto',
    mixBlendMode: 'normal', overflow: 'visible' };
  function nonDefaultStyles(el) {
    var s = styles(el); var out = {}; var any = false;
    for (var k in DEFAULTS) { if (s[k] !== DEFAULTS[k]) { out[k] = s[k]; any = true; } }
    return any ? out : null;
  }

  function isFlexOrGridItem(el) {
    var p = parentEl(el);
    if (!p) return false;
    return /flex|grid/.test(cs(p).display);
  }
  function isTopLayer(el) {
    try { if (el.matches(':modal')) return 'modal dialog (top layer)'; } catch (e) {}
    try { if (el.matches(':popover-open')) return 'open popover (top layer)'; } catch (e) {}
    try { if (el.matches(':fullscreen')) return 'fullscreen element (top layer)'; } catch (e) {}
    return null;
  }
  function shortVal(v) { return v.length > 40 ? v.slice(0, 39) + '…' : v; }
  function scReason(el) {
    if (el === document.documentElement) return 'root element';
    var s = cs(el);
    var tl = isTopLayer(el);
    if (tl) return tl;
    var pos = s.position, z = s.zIndex;
    if (pos === 'fixed' || pos === 'sticky') return 'position: ' + pos;
    if ((pos === 'relative' || pos === 'absolute') && z !== 'auto') return 'position: ' + pos + ' + z-index: ' + z;
    if (z !== 'auto' && isFlexOrGridItem(el)) return 'flex/grid item with z-index: ' + z;
    if (parseFloat(s.opacity) < 1) return 'opacity: ' + s.opacity;
    if (s.transform !== 'none') return 'transform: ' + shortVal(s.transform);
    if (s.translate && s.translate !== 'none') return 'translate: ' + s.translate;
    if (s.rotate && s.rotate !== 'none') return 'rotate: ' + s.rotate;
    if (s.scale && s.scale !== 'none') return 'scale: ' + s.scale;
    if (s.perspective !== 'none') return 'perspective: ' + s.perspective;
    if (s.filter !== 'none') return 'filter: ' + shortVal(s.filter);
    if (s.backdropFilter && s.backdropFilter !== 'none') return 'backdrop-filter: ' + shortVal(s.backdropFilter);
    if (s.clipPath && s.clipPath !== 'none') return 'clip-path: ' + shortVal(s.clipPath);
    var mask = s.maskImage || s.webkitMaskImage;
    if (mask && mask !== 'none') return 'mask-image';
    if (s.isolation === 'isolate') return 'isolation: isolate';
    if (s.mixBlendMode !== 'normal') return 'mix-blend-mode: ' + s.mixBlendMode;
    if (s.willChange && s.willChange !== 'auto' &&
        /(^|,\s*)(transform|opacity|filter|isolation|z-index|perspective|clip-path|mask|mask-image|mix-blend-mode|translate|rotate|scale|backdrop-filter)(\s*,|$)/.test(s.willChange)) {
      return 'will-change: ' + s.willChange;
    }
    if (/\b(paint|layout|strict|content)\b/.test(s.contain)) return 'contain: ' + s.contain;
    if (s.containerType === 'size' || s.containerType === 'inline-size') return 'container-type: ' + s.containerType;
    return null;
  }
  function chain(el) {
    var out = []; var n = el;
    while (n) { var r = scReason(n); if (r) out.push({ el: n, reason: r }); n = parentEl(n); }
    return out;
  }
  function paintKey(el) {
    if (isTopLayer(el)) return [9, 0];
    var s = cs(el);
    var positioned = s.position !== 'static';
    var z = s.zIndex;
    if ((positioned || isFlexOrGridItem(el)) && z !== 'auto') {
      var n = parseInt(z, 10);
      if (n < 0) return [1, n];
      if (n === 0) return [5, 0];
      return [6, n];
    }
    if (positioned || scReason(el)) return [5, 0];
    if (s.float !== 'none') return [3, 0];
    if (/^inline/.test(s.display)) return [4, 0];
    return [2, 0];
  }
  /** > 0 when b paints above a (both participating in the same stacking context). */
  function comparePaint(a, b) {
    if (a === b) return 0;
    if (contains(a, b)) return 1;
    if (contains(b, a)) return -1;
    var ka = paintKey(a), kb = paintKey(b);
    if (ka[0] !== kb[0]) return kb[0] - ka[0];
    if (ka[1] !== kb[1]) return kb[1] - ka[1];
    return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? 1 : -1;
  }

  function info(el) {
    if (!el) return null;
    var s = cs(el);
    return {
      label: label(el), selector: shortSelector(el), path: cssPath(el), rect: rectOf(el),
      zIndex: s.zIndex, position: s.position, stackingContext: scReason(el)
    };
  }
  function fullInfo(el) {
    var base = info(el);
    base.styles = styles(el);
    var anc = [];
    var p = parentEl(el);
    while (p && anc.length < 12) {
      var nd = nonDefaultStyles(p);
      if (nd) anc.push({ label: label(p), selector: shortSelector(p), path: cssPath(p), styles: nd, stackingContext: scReason(p) });
      p = parentEl(p);
    }
    base.ancestors = anc;
    return base;
  }

  // ---------- visual invisibility ----------
  function alpha(color) {
    if (!color || color === 'transparent') return 0;
    var m = color.match(/rgba?\(([^)]+)\)/);
    if (!m) return 1;
    var parts = m[1].split(/[\s,\/]+/).filter(Boolean);
    if (parts.length < 4) return 1;
    var a = parts[3];
    return a.indexOf('%') >= 0 ? parseFloat(a) / 100 : parseFloat(a);
  }
  function effectiveOpacity(el) {
    var o = 1; var n = el; var culprit = null;
    while (n) {
      var v = parseFloat(cs(n).opacity);
      if (v < 1 && (!culprit || v < parseFloat(cs(culprit).opacity))) culprit = n;
      o *= v; n = parentEl(n);
    }
    return { value: o, culprit: culprit };
  }
  function paintsBox(s) {
    var reasons = [];
    if (alpha(s.backgroundColor) > 0.02) reasons.push('background-color');
    if (s.backgroundImage && s.backgroundImage !== 'none') reasons.push('background-image');
    var sides = ['Top', 'Right', 'Bottom', 'Left'];
    for (var i = 0; i < 4; i++) {
      var w = parseFloat(s['border' + sides[i] + 'Width']);
      var st = s['border' + sides[i] + 'Style'];
      if (w > 0 && st !== 'none' && st !== 'hidden' && alpha(s['border' + sides[i] + 'Color']) > 0.02) { reasons.push('border'); break; }
    }
    if (s.boxShadow && s.boxShadow !== 'none') reasons.push('box-shadow');
    if (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 && alpha(s.outlineColor) > 0.02) reasons.push('outline');
    if (s.backdropFilter && s.backdropFilter !== 'none') reasons.push('backdrop-filter');
    return reasons;
  }
  function ownText(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var c = el.childNodes[i];
      if (c.nodeType === 3 && c.textContent.trim()) return true;
    }
    return false;
  }
  function pseudoOverlay(el, which) {
    var s = cs(el, which);
    if (!s || s.content === 'none' || s.content === 'normal') return null;
    if (s.display === 'none') return null;
    if (s.position !== 'absolute' && s.position !== 'fixed') return null;
    if (s.pointerEvents === 'none' || s.visibility !== 'visible') return null;
    return s;
  }
  function pseudoInvisibility(el, which) {
    var s = pseudoOverlay(el, which);
    if (!s) return null;
    var painted = paintsBox(s);
    var c = s.content;
    var textContent = c && c !== '""' && c !== "''" && !/^url\(/.test(c) ? c.replace(/^["']|["']$/g, '').trim() : '';
    if (/^url\(/.test(c)) painted.push('content image');
    if (textContent) painted.push('content text');
    var op = parseFloat(s.opacity);
    var eo = effectiveOpacity(el).value * op;
    if (eo <= 0.02) return { invisible: true, reasons: [which + ' pseudo-element with opacity ~0'], pseudo: which };
    if (!painted.length) return { invisible: true, reasons: [which + ' pseudo-element (position: ' + s.position + ') with no painted content: transparent background, no border, empty content'], pseudo: which };
    return { invisible: false, reasons: [which + ' pseudo-element paints ' + painted.join(', ')], pseudo: which };
  }
  /** Is this element (as a hit-test winner) visually invisible? */
  function invisibility(el) {
    var eo = effectiveOpacity(el);
    if (eo.value <= 0.02) {
      var where = eo.culprit && eo.culprit !== el ? ' (inherited from ' + label(eo.culprit) + ')' : '';
      return { invisible: true, reasons: ['opacity: ' + (eo.culprit ? cs(eo.culprit).opacity : '0') + where], pseudo: null };
    }
    var s = cs(el);
    if (REPLACED[el.tagName.toUpperCase()]) return { invisible: false, reasons: ['replaced/form element'], pseudo: null };
    var painted = paintsBox(s);
    if (ownText(el)) painted.push('text');
    if (painted.length) return { invisible: false, reasons: ['paints ' + painted.join(', ')], pseudo: null };
    var r = [];
    r.push('paints nothing: transparent background, no border, no shadow, no own text or image');
    if (s.position === 'absolute' || s.position === 'fixed') r.push('position: ' + s.position + ' wrapper');
    return { invisible: true, reasons: r, pseudo: null };
  }
  /** When an ancestor wins the hit test over its own descendant, a positioned pseudo-element is the usual cause. */
  function coveringPseudo(el) {
    var a = pseudoInvisibility(el, '::after');
    if (a) return a;
    return pseudoInvisibility(el, '::before');
  }

  // ---------- clipping ----------
  function createsContainingBlockForFixed(s) {
    return s.transform !== 'none' || s.filter !== 'none' || s.perspective !== 'none' ||
      /\b(paint|layout|strict|content)\b/.test(s.contain) || /transform|filter|perspective/.test(s.willChange);
  }
  function clippers(el) {
    var out = [];
    var mode = cs(el).position;
    var p = parentEl(el);
    while (p && p !== document.body && p !== document.documentElement) {
      var ps = cs(p);
      var isCB;
      if (mode === 'fixed') isCB = createsContainingBlockForFixed(ps);
      else if (mode === 'absolute') isCB = ps.position !== 'static' || createsContainingBlockForFixed(ps);
      else isCB = true;
      if (isCB) {
        if (ps.overflowX !== 'visible' || ps.overflowY !== 'visible' || /\b(paint|strict|content)\b/.test(ps.contain)) out.push(p);
        mode = ps.position;
      }
      p = parentEl(p);
    }
    return out;
  }
  function intersect(a, b) {
    var l = Math.max(a.l, b.l), t = Math.max(a.t, b.t), r = Math.min(a.r, b.r), bt = Math.min(a.b, b.b);
    if (r - l < 1 || bt - t < 1) return null;
    return { l: l, t: t, r: r, b: bt };
  }
  function area(x) { return (x.r - x.l) * (x.b - x.t); }

  function findTarget(selector) {
    var els;
    try { els = document.querySelectorAll(selector); } catch (e) { return { error: 'Invalid CSS selector: ' + selector }; }
    return { els: els };
  }

  var api = {
    prepare: function (a) {
      var f = findTarget(a.selector);
      if (f.error) return { status: 'ERROR', error: f.error };
      if (!f.els.length) return { status: 'NOT_FOUND', matchCount: 0 };
      var t = f.els[0];
      state.target = t;
      state.clicks = [];
      var out = { matchCount: f.els.length, target: info(t) };

      var n = t;
      while (n) {
        if (cs(n).display === 'none') {
          out.status = 'INVISIBLE'; out.kind = 'display'; out.culprit = info(n);
          return out;
        }
        n = parentEl(n);
      }
      var r = t.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) {
        out.status = 'ZERO_SIZE'; out.display = cs(t).display; out.target = fullInfo(t);
        return out;
      }
      if (cs(t).visibility !== 'visible') {
        var c = t, p = parentEl(c);
        while (p && cs(p).visibility !== 'visible') { c = p; p = parentEl(p); }
        out.status = 'INVISIBLE'; out.kind = 'visibility'; out.culprit = info(c);
        return out;
      }
      var vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
      if (r.top < 0 || r.left < 0 || r.bottom > vh || r.right > vw) {
        t.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        out.scrolled = true;
        r = t.getBoundingClientRect();
      }
      out.target = info(t);
      var vis = { l: r.left, t: r.top, r: r.right, b: r.bottom };
      var cl = clippers(t);
      var partial = null;
      for (var i = 0; i < cl.length; i++) {
        var ce = cl[i], cr = ce.getBoundingClientRect();
        var box = { l: cr.left + ce.clientLeft, t: cr.top + ce.clientTop };
        box.r = box.l + ce.clientWidth; box.b = box.t + ce.clientHeight;
        var nv = intersect(vis, box);
        if (!nv) {
          var cinfo = info(ce); cinfo.overflow = styles(ce).overflow;
          out.status = 'OUTSIDE_VIEWPORT_OR_CLIPPED'; out.clippedBy = cinfo; out.outsideViewport = false;
          return out;
        }
        if (area(nv) < area(vis) - 1 && !partial) { partial = info(ce); partial.overflow = styles(ce).overflow; }
        vis = nv;
      }
      var vv = intersect(vis, { l: 0, t: 0, r: vw, b: vh });
      if (!vv) {
        out.status = 'OUTSIDE_VIEWPORT_OR_CLIPPED'; out.clippedBy = null; out.outsideViewport = true;
        return out;
      }
      vis = vv;
      if (partial) out.partiallyClippedBy = partial;
      var cx = round((vis.l + vis.r) / 2), cy = round((vis.t + vis.b) / 2), inset = 3;
      var wide = vis.r - vis.l > 2 * inset + 2, tall = vis.b - vis.t > 2 * inset + 2;
      var L = wide ? round(vis.l + inset) : cx, R = wide ? round(vis.r - inset) : cx;
      var T = tall ? round(vis.t + inset) : cy, B = tall ? round(vis.b - inset) : cy;
      var pts = [['center', cx, cy], ['top-left', L, T], ['top', cx, T], ['top-right', R, T], ['left', L, cy],
        ['right', R, cy], ['bottom-left', L, B], ['bottom', cx, B], ['bottom-right', R, B]];
      var seen = {}; out.points = [];
      for (var j = 0; j < pts.length; j++) {
        var key = pts[j][1] + ',' + pts[j][2];
        if (seen[key]) continue;
        seen[key] = 1;
        out.points.push({ name: pts[j][0], x: pts[j][1], y: pts[j][2] });
      }
      var eo = effectiveOpacity(t);
      out.effectiveOpacity = round(eo.value * 1000) / 1000;
      out.opacityCulprit = eo.value <= 0.02 && eo.culprit ? info(eo.culprit) : null;
      out.status = 'PROBE';
      return out;
    },

    installCapture: function () {
      if (state.handler) return;
      state.down = null; state.click = null;
      var h = function (e) {
        var tgt = e.composedPath ? e.composedPath()[0] : e.target;
        if (tgt && tgt.nodeType !== 1) tgt = tgt.parentElement;
        if (e.type === 'pointerdown' || e.type === 'mousedown') { if (!state.down) state.down = tgt; }
        if (e.type === 'click') state.click = tgt;
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      state.handler = h;
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'dblclick', 'contextmenu'].forEach(function (t) {
        window.addEventListener(t, h, true);
      });
    },
    takeClick: function () {
      var el = state.click || state.down;
      var via = state.click ? 'click' : (state.down ? 'pointerdown' : null);
      state.click = null; state.down = null;
      state.clicks.push(el || null);
      var t = state.target;
      return { receivedBy: el ? label(el) : null, path: el ? cssPath(el) : null, event: via, reachedTarget: !!(el && t && contains(t, el)) };
    },
    removeCapture: function () {
      if (!state.handler) return;
      var h = state.handler;
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'dblclick', 'contextmenu'].forEach(function (t) {
        window.removeEventListener(t, h, true);
      });
      state.handler = null;
    },

    analyze: function (a) {
      var t = state.target;
      var probes = [];
      for (var i = 0; i < a.points.length; i++) {
        var p = a.points[i];
        var el = document.elementFromPoint(p.x, p.y);
        probes.push({ name: p.name, x: p.x, y: p.y, elementFromPoint: el ? label(el) : null, hitsTarget: !!(el && contains(t, el)) });
      }
      var c0 = a.points[0];
      var stackEls = document.elementsFromPoint(c0.x, c0.y);
      var tIdx = -1;
      for (var k = 0; k < stackEls.length; k++) { if (contains(t, stackEls[k])) { tIdx = k; break; } }
      var lim = Math.max(8, tIdx + 2);
      var stack = stackEls.slice(0, lim).map(function (e, i2) {
        var s = cs(e);
        return { index: i2, label: label(e), selector: shortSelector(e), path: cssPath(e), isTarget: contains(t, e),
          position: s.position, zIndex: s.zIndex, pointerEvents: s.pointerEvents, opacity: s.opacity, stackingContext: scReason(e) };
      });
      var res = { probes: probes, stack: stack, target: fullInfo(t) };
      try { res.disabled = t.matches(':disabled'); } catch (e) { res.disabled = false; }

      if (cs(t).pointerEvents === 'none') {
        var pc = t, pp = parentEl(pc);
        while (pp && cs(pp).pointerEvents === 'none') { pc = pp; pp = parentEl(pp); }
        res.pointerEventsCulprit = info(pc);
      }

      var occ = null;
      var clk = state.clicks[0];
      if (clk && !contains(t, clk)) occ = clk;
      else if (!clk) {
        var e0 = document.elementFromPoint(c0.x, c0.y);
        if (e0 && !contains(t, e0)) occ = e0;
      }
      if (occ) {
        res.occluder = fullInfo(occ);
        res.occluderRelation = contains(occ, t) ? 'ancestor' : 'other';
        if (res.occluderRelation === 'ancestor') {
          var ps = coveringPseudo(occ);
          res.occluderInvisibility = ps || { invisible: false, reasons: ['ancestor of the target wins the hit test'], pseudo: null };
          res.occluderPseudo = ps ? ps.pseudo : null;
        } else {
          res.occluderInvisibility = invisibility(occ);
          res.stacking = stackingAnalysis(t, occ);
        }
      }
      res.passThroughOverlays = passThrough(t, c0);
      return res;
    },

    stackAt: function (a) {
      var els = document.elementsFromPoint(a.x, a.y);
      return els.slice(0, a.limit || 12).map(function (e, i) {
        var s = cs(e);
        var inv = invisibility(e);
        return { index: i, label: label(e), selector: shortSelector(e), path: cssPath(e), rect: rectOf(e),
          position: s.position, zIndex: s.zIndex, pointerEvents: s.pointerEvents, opacity: s.opacity,
          visibility: s.visibility, stackingContext: scReason(e), paintLayer: LAYER_NAMES[paintKey(e)[0]],
          visuallyInvisible: inv.invisible, invisibleReasons: inv.invisible ? inv.reasons : [],
          stackingChain: chain(e).map(function (c) { return { label: label(c.el), reason: c.reason }; }) };
      });
    },

    elementPath: function (a) {
      var f = findTarget(a.selector);
      if (f.error) return { error: f.error };
      if (!f.els.length) return { notFound: true };
      return { path: cssPath(f.els[0]), label: label(f.els[0]), matchCount: f.els.length, info: fullInfo(f.els[0]) };
    },

    scan: function (a) {
      var step = a.step || 24;
      var vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
      var groups = {}; var order = [];
      var gridPoints = 0;
      var pts = [];
      for (var gy = Math.floor(step / 2); gy < vh; gy += step) {
        for (var gx = Math.floor(step / 2); gx < vw; gx += step) pts.push([gx, gy]);
      }
      gridPoints = pts.length;
      // Small controls can fall between grid lines: also probe the center of every interactive element in view.
      var inter = document.querySelectorAll(INTERACTIVE);
      for (var ii = 0; ii < inter.length && ii < 3000; ii++) {
        var ir = inter[ii].getBoundingClientRect();
        if (ir.width < 1 || ir.height < 1 || ir.bottom <= 0 || ir.right <= 0 || ir.top >= vh || ir.left >= vw) continue;
        pts.push([round((Math.max(ir.left, 0) + Math.min(ir.right, vw)) / 2), round((Math.max(ir.top, 0) + Math.min(ir.bottom, vh)) / 2)]);
      }
      for (var pi = 0; pi < pts.length; pi++) {
        {
          var x = pts[pi][0], y = pts[pi][1];
          var stackEls = document.elementsFromPoint(x, y);
          var top = stackEls[0];
          if (!top || top === document.documentElement || top === document.body) continue;
          if (top.closest(INTERACTIVE)) continue;
          var inv = null, covered = null;
          for (var i = 1; i < stackEls.length; i++) {
            var cand = stackEls[i].closest(INTERACTIVE);
            if (!cand || contains(cand, top)) continue;
            if (cs(cand).visibility !== 'visible' || effectiveOpacity(cand).value <= 0.05) continue;
            var cr = cand.getBoundingClientRect();
            if (x < cr.left || x > cr.right || y < cr.top || y > cr.bottom) continue;
            covered = cand; break;
          }
          if (!covered) continue;
          if (contains(top, covered)) inv = coveringPseudo(top);
          else inv = invisibility(top);
          if (!inv || !inv.invisible) continue;
          var key = cssPath(top) + (inv.pseudo || '');
          var g = groups[key];
          if (!g) {
            g = groups[key] = { el: top, pseudo: inv.pseudo, reasons: inv.reasons, points: 0, sample: { x: x, y: y }, covered: {} , coveredOrder: [] };
            order.push(key);
          }
          g.points++;
          var cp = cssPath(covered);
          if (!g.covered[cp]) { g.covered[cp] = { label: label(covered), selector: shortSelector(covered), path: cp, sample: { x: x, y: y } }; g.coveredOrder.push(cp); }
        }
      }
      return {
        viewportWidth: vw, viewportHeight: vh, step: step, gridPoints: gridPoints, probedPoints: pts.length,
        blockers: order.map(function (k) {
          var g = groups[k];
          var inf = fullInfo(g.el);
          var cov = g.coveredOrder.map(function (p) { return g.covered[p]; });
          return { occluder: inf, pseudo: g.pseudo, reasons: g.reasons, hitPoints: g.points, approxBlockedArea: g.points * step * step,
            samplePoint: cov[0].sample, coveredElements: cov };
        })
      };
    },

    setTargetPath: function (a) {
      var t = null;
      try { t = document.querySelector(a.path); } catch (e) {}
      state.target = t;
      state.clicks = [];
      return !!t;
    },

    highlight: function (a) {
      api.clearHighlight();
      a.boxes.forEach(function (b) {
        var el = null;
        try { el = document.querySelector(b.path); } catch (e) {}
        if (!el) return;
        var r = el.getBoundingClientRect();
        var d = document.createElement('div');
        d.setAttribute('data-css-lab-mark', '');
        d.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;' +
          'left:' + r.left + 'px;top:' + r.top + 'px;width:' + Math.max(r.width, 2) + 'px;height:' + Math.max(r.height, 2) + 'px;' +
          'border:3px solid ' + b.color + ';background:' + b.fill + ';';
        var tag = document.createElement('span');
        tag.textContent = b.text;
        tag.style.cssText = 'position:absolute;left:-3px;top:-22px;font:600 12px/18px system-ui,sans-serif;color:#fff;' +
          'background:' + b.color + ';padding:1px 6px;border-radius:3px;white-space:nowrap;';
        if (r.top < 24) tag.style.top = '100%';
        d.appendChild(tag);
        document.documentElement.appendChild(d);
        state.marks.push(d);
      });
    },
    clearHighlight: function () {
      state.marks.forEach(function (m) { m.remove(); });
      state.marks = [];
    },

    cssomRules: function (a) {
      var el = null;
      try { el = document.querySelector(a.path); } catch (e) {}
      if (!el) return { rules: [], blockedSheets: [] };
      var out = [], blocked = [];
      var props = a.properties;
      function visit(rules, href) {
        for (var i = 0; i < rules.length; i++) {
          var r = rules[i];
          if (r.selectorText !== undefined && r.style) {
            var ok = false;
            try { ok = el.matches(r.selectorText); } catch (e) {}
            if (ok) {
              for (var j = 0; j < props.length; j++) {
                var v = r.style.getPropertyValue(props[j]);
                if (v) out.push({ selector: r.selectorText, property: props[j], value: v.trim(),
                  important: r.style.getPropertyPriority(props[j]) === 'important', source: href || 'inline <style>', line: null });
              }
            }
          }
          if (r.cssRules) visit(r.cssRules, href);
        }
      }
      for (var s = 0; s < document.styleSheets.length; s++) {
        var sh = document.styleSheets[s], rules;
        try { rules = sh.cssRules; } catch (e) { blocked.push(sh.href); continue; }
        visit(rules, sh.href);
      }
      for (var k = 0; k < props.length; k++) {
        var iv = el.style.getPropertyValue(props[k]);
        if (iv) out.push({ selector: 'style attribute', property: props[k], value: iv.trim(), important: el.style.getPropertyPriority(props[k]) === 'important', source: 'style attribute', line: null });
      }
      return { rules: out, blockedSheets: blocked };
    }
  };

  function stackingAnalysis(t, o) {
    var ct = chain(t), co = chain(o);
    var it = -1, io = -1;
    for (var i = 0; i < ct.length && it < 0; i++) {
      for (var j = 0; j < co.length; j++) { if (co[j].el === ct[i].el) { it = i; io = j; break; } }
    }
    if (it < 0) return null;
    var lca = ct[it].el;
    function rep(el, arr, idx) {
      if (idx > 0) return { el: arr[idx - 1].el, isStackingContext: true, reason: arr[idx - 1].reason };
      if (el === lca) return { el: el, isStackingContext: true, reason: arr[idx].reason };
      var best = el, n = el;
      while (n && n !== lca) { if (cs(n).position !== 'static') best = n; n = parentEl(n); }
      return { el: best, isStackingContext: !!scReason(best), reason: scReason(best) };
    }
    var bt = rep(t, ct, it), bo = rep(o, co, io);
    var kt = paintKey(bt.el), ko = paintKey(bo.el);
    var cmp = comparePaint(bt.el, bo.el);
    var floating = null;
    if (bt.el !== t && contains(bt.el, t)) {
      var n = t;
      while (n && n !== bt.el) { if (cs(n).position !== 'static') floating = n; n = parentEl(n); }
    }
    function mapChain(c) { return { label: label(c.el), selector: shortSelector(c.el), path: cssPath(c.el), reason: c.reason, zIndex: cs(c.el).zIndex }; }
    function branch(b, k) {
      var x = info(b.el);
      x.isStackingContext = b.isStackingContext; x.reason = b.reason; x.paintLayer = LAYER_NAMES[k[0]]; x.layerRank = k[0]; x.layerZ = k[1];
      return x;
    }
    return {
      targetChain: ct.map(mapChain), occluderChain: co.map(mapChain),
      commonAncestor: mapChain(ct[it]),
      targetBranch: branch(bt, kt), occluderBranch: branch(bo, ko),
      occluderPaintsAbove: cmp > 0,
      sameLayer: kt[0] === ko[0] && kt[1] === ko[1],
      occluderLaterInDom: !!(bt.el.compareDocumentPosition(bo.el) & Node.DOCUMENT_POSITION_FOLLOWING),
      trapped: bt.isStackingContext && bt.el !== t,
      floating: floating ? info(floating) : null,
      stateSelector: stateSelector(t, bt.el),
      branchSelector: shortSelector(bt.el),
      occluderBranchSelector: shortSelector(bo.el)
    };
  }

  function domLca(a, b) {
    var n = a;
    while (n) { if (contains(n, b)) return n; n = parentEl(n); }
    return document.documentElement;
  }
  /** The element that represents el in the paint order of stop's subtree: topmost stacking context, else topmost positioned box, else el. */
  function repBelow(el, stop) {
    var n = el, sc = null, pos = null;
    while (n && n !== stop) {
      if (scReason(n)) sc = n;
      else if (cs(n).position !== 'static') pos = n;
      n = parentEl(n);
    }
    return sc || pos || el;
  }

  /** Visible overlays above the target that let clicks pass through (pointer-events: none). */
  function passThrough(t, pt) {
    var out = [];
    var all = document.querySelectorAll('*');
    if (all.length > 8000) return out;
    for (var i = 0; i < all.length && out.length < 5; i++) {
      var e = all[i];
      if (contains(e, t) || contains(t, e)) continue;
      var s = cs(e);
      if (s.pointerEvents !== 'none' || s.visibility !== 'visible' || s.display === 'none') continue;
      var p = parentEl(e);
      if (p && cs(p).pointerEvents === 'none') continue;
      var r = e.getBoundingClientRect();
      if (pt.x < r.left || pt.x > r.right || pt.y < r.top || pt.y > r.bottom) continue;
      var stop = domLca(t, e);
      if (comparePaint(repBelow(t, stop), repBelow(e, stop)) > 0) out.push(info(e));
    }
    return out;
  }

  Object.defineProperty(window, '__cssLab__', { value: api, enumerable: false, configurable: true });
})();
`;
