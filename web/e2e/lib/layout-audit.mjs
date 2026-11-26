export async function auditDesktopLayout(page, viewName) {
  const report = await page.evaluate((label) => {
    window.scrollTo(0, 0);
    const issues = [];
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const docScrollW = document.documentElement.scrollWidth;
    const docClientW = document.documentElement.clientWidth;

    if (docScrollW > vw + 1) {
      issues.push(`Horizontal page overflow on ${label}: scrollWidth=${docScrollW} > innerWidth=${vw}`);
    }

    const isDomShown = (el) => {
      let cur = el;
      while (cur && cur.nodeType === 1) {
        if (cur.hasAttribute('hidden')) return false;
        if (cur.tagName === 'DIALOG' && !cur.hasAttribute('open')) return false;
        if (
          cur.tagName !== 'SUMMARY' &&
          cur.parentElement?.tagName === 'DETAILS' &&
          !cur.parentElement.hasAttribute('open')
        ) {
          return false;
        }
        const style = window.getComputedStyle(cur);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
          return false;
        }
        if (cur === document.body) break;
        cur = cur.parentElement;
      }
      return true;
    };

    const isInsideHorizScrollContainer = (el) => {
      let cur = el.parentElement;
      while (cur && cur !== document.body) {
        const st = window.getComputedStyle(cur);
        if ((st.overflowX === 'auto' || st.overflowX === 'scroll') && cur.clientWidth <= vw + 2) {
          return true;
        }
        cur = cur.parentElement;
      }
      return false;
    };

    const describeEl = (el) =>
      (el.textContent || el.getAttribute('aria-label') || el.tagName || '').replace(/\s+/g, ' ').trim().slice(0, 30);

    const selectors = [
      'header button',
      'nav button',
      'main h1',
      'main h2',
      'main button',
      'main input',
      'main canvas',
      'main svg',
      '[role="meter"]',
      '[role="timer"]',
    ];

    for (const sel of selectors) {
      const els = [...document.querySelectorAll(sel)];
      for (const el of els) {
        if (!isDomShown(el)) continue;
        // Skip tiny decorative icons inside buttons/headings
        if (sel === 'main svg' && el.closest('button, h1, h2, h3, span')) continue;

        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) {
          issues.push(`Zero-size element (${sel}) on ${label}: "${describeEl(el)}"`);
          continue;
        }
        if (!isInsideHorizScrollContainer(el) && (r.left < -2 || r.right > vw + 2)) {
          issues.push(
            `Horizontal clipping (${sel}) on ${label}: left=${Math.round(r.left)}, right=${Math.round(r.right)}, vw=${vw}, text="${describeEl(el)}"`,
          );
        }
      }
    }

    // Ancestor overflow:hidden / overflow:clip clipping check on visible interactive controls
    const interactiveSelectors = [
      'header button',
      'nav button',
      'main button',
      'main input',
      'main select',
      'main textarea',
      'main a[href]',
      'dialog[open] button',
      '[role="dialog"] button',
    ];
    const checkedInteractive = new Set();
    for (const sel of interactiveSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (checkedInteractive.has(el)) continue;
        checkedInteractive.add(el);
        if (!isDomShown(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if (isInsideHorizScrollContainer(el)) continue;
        if (window.getComputedStyle(el).position === 'fixed') continue;

        let cur = el.parentElement;
        while (cur && cur.nodeType === 1) {
          const st = window.getComputedStyle(cur);
          const clipsX = st.overflowX === 'hidden' || st.overflowX === 'clip';
          const clipsY = st.overflowY === 'hidden' || st.overflowY === 'clip';
          if (clipsX || clipsY) {
            const cr = cur.getBoundingClientRect();
            const clippedX = clipsX && cr.width > 0 && (r.left < cr.left - 2 || r.right > cr.right + 2);
            const clippedY = clipsY && cr.height > 0 && (r.top < cr.top - 2 || r.bottom > cr.bottom + 2);
            if (clippedX || clippedY) {
              issues.push(
                `Ancestor overflow clipping (${cur.tagName.toLowerCase()}${cur.className ? `.${String(cur.className).trim().split(/\s+/)[0]}` : ''}) on ${label}: control="${describeEl(el)}" (${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}) outside (${Math.round(cr.left)},${Math.round(cr.top)},${Math.round(cr.right)},${Math.round(cr.bottom)})`,
              );
              break;
            }
          }
          if (cur === document.body) break;
          cur = cur.parentElement;
        }
      }
    }

    // Sibling overlap check in interactive groups (M1-M4)
    const groupSelectors = [
      'nav',
      'header .market-status',
      'main fieldset .fishing-depth-options',
      '.fx-options',
      '.economy-actions',
      '.hall-actions',
      '.scratch-shop',
      '.lottery-pools',
      '.water-chart',
      '.water-chart-modal',
      '.fx-chart-controls',
      '.fx-k-controls',
      '.sea-chart-waypoints',
      '.scratch-actions',
      '[role="group"]',
    ];

    const seenGroups = new Set();
    for (const gSel of groupSelectors) {
      const groups = [...document.querySelectorAll(gSel)];
      for (const group of groups) {
        if (seenGroups.has(group)) continue;
        seenGroups.add(group);
        if (!isDomShown(group)) continue;
        const gr = group.getBoundingClientRect();
        if (gr.width <= 0 || gr.height <= 0) continue;

        const children = [...group.children].filter((c) => {
          if (!isDomShown(c)) return false;
          if (c.getAttribute('aria-hidden') === 'true') return false;
          const cr = c.getBoundingClientRect();
          return cr.width > 0 && cr.height > 0;
        });
        for (let i = 0; i < children.length; i += 1) {
          const a = children[i].getBoundingClientRect();
          for (let j = i + 1; j < children.length; j += 1) {
            const b = children[j].getBoundingClientRect();
            const overlapX = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
            const overlapY = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
            if (overlapX * overlapY > 4) {
              issues.push(
                `Sibling overlap in ${gSel} on ${label}: "${describeEl(children[i])}" vs "${describeEl(children[j])}" (${Math.round(overlapX)}x${Math.round(overlapY)})`,
              );
            }
          }
        }
      }
    }

    // Fixed/sticky header & overlay intersection against visible interactive main controls at scrollY=0
    const openModals = [...document.querySelectorAll('dialog[open], [role="dialog"], .water-dialog, .water-chart-modal')]
      .filter((m) => isDomShown(m) && !m.classList.contains('water-chart'));

    const fixedOverlays = [];
    for (const h of document.querySelectorAll('header, nav')) {
      if (!isDomShown(h)) continue;
      if (fixedOverlays.some((f) => f.el.contains(h))) continue;
      const st = window.getComputedStyle(h);
      if (st.position === 'fixed' || st.position === 'sticky') {
        const hr = h.getBoundingClientRect();
        if (hr.width > 0 && hr.height > 0) fixedOverlays.push({ el: h, rect: hr, z: Number(st.zIndex) || 0 });
      }
    }
    for (const ov of document.querySelectorAll('[data-overlay], .sticky-overlay')) {
      if (!isDomShown(ov)) continue;
      const st = window.getComputedStyle(ov);
      if (st.position === 'fixed' || st.position === 'sticky') {
        const or = ov.getBoundingClientRect();
        if (or.width > 0 && or.height > 0) fixedOverlays.push({ el: ov, rect: or, z: Number(st.zIndex) || 0 });
      }
    }

    if (fixedOverlays.length > 0) {
      const mainControls = [
        ...document.querySelectorAll('main button, main input, main select, main textarea, main a[href]'),
      ].filter((el) => {
        if (!isDomShown(el)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });

      for (const ctrl of mainControls) {
        const insideModal = openModals.some((m) => m.contains(ctrl));
        if (openModals.length > 0 && !insideModal) {
          // Modal intentionally overlays background main controls
          continue;
        }
        if (insideModal) {
          // Native <dialog open> (showModal) lives in top-layer above header; only check non-top-layer modals if z-index <= header
          const hostModal = openModals.find((m) => m.contains(ctrl));
          if (hostModal?.tagName === 'DIALOG' && hostModal.hasAttribute('open')) continue;
          const modalZ = hostModal ? Number(window.getComputedStyle(hostModal).zIndex) || 0 : 0;
          const cr = ctrl.getBoundingClientRect();
          for (const ov of fixedOverlays) {
            if (ov.el.contains(ctrl)) continue;
            if (modalZ > ov.z) continue;
            const ox = Math.max(0, Math.min(cr.right, ov.rect.right) - Math.max(cr.left, ov.rect.left));
            const oy = Math.max(0, Math.min(cr.bottom, ov.rect.bottom) - Math.max(cr.top, ov.rect.top));
            if (ox * oy > 4) {
              issues.push(
                `Header/overlay overlaps modal control on ${label}: "${describeEl(ctrl)}" (${Math.round(ox)}x${Math.round(oy)})`,
              );
            }
          }
          continue;
        }

        const cr = ctrl.getBoundingClientRect();
        for (const ov of fixedOverlays) {
          if (ov.el.contains(ctrl)) continue;
          const ox = Math.max(0, Math.min(cr.right, ov.rect.right) - Math.max(cr.left, ov.rect.left));
          const oy = Math.max(0, Math.min(cr.bottom, ov.rect.bottom) - Math.max(cr.top, ov.rect.top));
          if (ox * oy > 4) {
            issues.push(
              `Header/overlay overlaps main interactive control on ${label}: "${describeEl(ctrl)}" (${Math.round(ox)}x${Math.round(oy)})`,
            );
          }
        }
      }
    }

    return {
      viewName: label,
      viewport: { width: vw, height: vh },
      scrollWidth: docScrollW,
      clientWidth: docClientW,
      issueCount: issues.length,
      issues,
    };
  }, viewName);

  if (report.issueCount > 0) {
    throw new Error(`Layout audit failed for ${viewName} (${report.viewport.width}x${report.viewport.height}):\n  - ${report.issues.join('\n  - ')}`);
  }
  return report;
}

export async function verifyFxChartNonBlank(surfaceLocator) {
  await surfaceLocator.waitFor({ state: 'visible', timeout: 8000 });
  const box = await surfaceLocator.boundingBox();
  if (!box || box.width < 200 || box.height < 120) {
    throw new Error(`FX chart surface too small or missing: ${JSON.stringify(box)}`);
  }

  const tag = await surfaceLocator.evaluate((el) => el.tagName.toLowerCase());
  if (tag === 'svg') {
    const geom = await surfaceLocator.evaluate((svg) => {
      const shapes = [...svg.querySelectorAll('rect, line, path')];
      const nonZero = shapes.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 || r.height > 0;
      });
      return { shapeCount: shapes.length, nonZeroCount: nonZero.length };
    });
    if (geom.shapeCount <= 0 || geom.nonZeroCount <= 0) {
      throw new Error(`FX SVG chart rendered blank geometry: ${JSON.stringify(geom)}`);
    }
    return { kind: 'svg', box, ...geom };
  }

  const sample = await sampleCanvasSignature(surfaceLocator);
  if (sample.nonZeroPixels <= 0 || sample.uniqueBuckets <= 2) {
    throw new Error(
      `FX canvas chart rendered blank/monochrome: nonZero=${sample.nonZeroPixels}, uniqueBuckets=${sample.uniqueBuckets}`,
    );
  }
  return { kind: 'canvas', box, nonZeroPixels: sample.nonZeroPixels, uniqueBuckets: sample.uniqueBuckets };
}

export async function sampleCanvasSignature(canvasLocator) {
  await canvasLocator.waitFor({ state: 'visible', timeout: 8000 });
  const box = await canvasLocator.boundingBox();
  if (!box || box.width < 100 || box.height < 80) {
    throw new Error(`Canvas bounding box too small or missing: ${JSON.stringify(box)}`);
  }

  const sample = await canvasLocator.evaluate((canvas) => {
    const w = Math.min(240, Math.max(32, canvas.width || Math.round(canvas.getBoundingClientRect().width)));
    const h = Math.min(140, Math.max(24, canvas.height || Math.round(canvas.getBoundingClientRect().height)));
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const ctx = off.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const colors = new Set();
    let nonZero = 0;
    const bgR = data[0];
    const bgG = data[1];
    const bgB = data[2];
    let nonBg = 0;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a > 0) nonZero += 1;
      if (Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB) > 6) nonBg += 1;
      if (colors.size < 64) {
        colors.add(`${r >> 3},${g >> 3},${b >> 3}`);
      }
    }

    return {
      boxWidth: Math.round(canvas.getBoundingClientRect().width),
      boxHeight: Math.round(canvas.getBoundingClientRect().height),
      sampleWidth: w,
      sampleHeight: h,
      totalPixels: w * h,
      nonZeroPixels: nonZero,
      nonBgPixels: nonBg,
      uniqueBuckets: colors.size,
      bytes: Array.from(data),
    };
  });

  return sample;
}

export function diffCanvasSamples(sampleA, sampleB) {
  if (sampleA.bytes.length !== sampleB.bytes.length) {
    throw new Error(`Cannot diff canvas samples of different sizes: ${sampleA.bytes.length} vs ${sampleB.bytes.length}`);
  }
  let changedPixels = 0;
  for (let i = 0; i < sampleA.bytes.length; i += 4) {
    const delta =
      Math.abs(sampleA.bytes[i] - sampleB.bytes[i]) +
      Math.abs(sampleA.bytes[i + 1] - sampleB.bytes[i + 1]) +
      Math.abs(sampleA.bytes[i + 2] - sampleB.bytes[i + 2]) +
      Math.abs(sampleA.bytes[i + 3] - sampleB.bytes[i + 3]);
    if (delta > 8) changedPixels += 1;
  }
  return changedPixels;
}
