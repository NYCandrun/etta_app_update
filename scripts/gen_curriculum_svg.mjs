#!/usr/bin/env node
// Build-time curriculum diagram generator (blocklist #49).
//
// Reads the 12 bundled domain JSON files and emits ONE self-contained static
// SVG plus a positions sidecar — at BUILD TIME, with NO d3 and NO runtime graph
// library. The dashboard renders the SVG as-is; a thin React layer overlays
// per-concept status dots using the positions sidecar (the diagram itself never
// changes — only the dot data does).
//
// Layout: phases are columns (left→right); each domain is a card stacked within
// its phase column; each concept is a small node laid out in a grid inside its
// domain card. Prerequisite edges are drawn aggregated at the DOMAIN level
// (concept-level edges would be unreadable at ~420 nodes and add no value to an
// informational map). Colors use CSS variables so the inline SVG themes.
//
// Run:  node scripts/gen_curriculum_svg.mjs
// Out:  src/assets/curriculum-map.svg, src/assets/curriculum-map-positions.json

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, "..", "src-tauri", "src", "curriculum", "data");
const OUT_DIR = join(HERE, "..", "src", "assets");

// ---- Load + group the curriculum ----

function loadDomains() {
  const files = readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
  const domains = files.map((f) => JSON.parse(readFileSync(join(DATA_DIR, f), "utf8")));
  // Stable order: by phase, then display name, so the diagram is deterministic.
  domains.sort((a, b) => a.phase - b.phase || a.display_name.localeCompare(b.display_name));
  return domains;
}

function escapeXml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ---- Layout constants ----

const NODE = 12; // concept dot diameter
const NODE_GAP = 6;
const NODES_PER_ROW = 6;
const CARD_PAD = 14;
const CARD_HEADER = 26;
const CARD_GAP_Y = 24;
const COL_GAP_X = 90;
const COL_W = NODES_PER_ROW * (NODE + NODE_GAP) - NODE_GAP + CARD_PAD * 2;
const MARGIN = 32;

function domainConcepts(domain) {
  return domain.modules.flatMap((m) => m.concepts);
}

function cardHeight(conceptCount) {
  const rows = Math.max(1, Math.ceil(conceptCount / NODES_PER_ROW));
  return CARD_HEADER + CARD_PAD + rows * (NODE + NODE_GAP) - NODE_GAP + CARD_PAD;
}

// ---- Build layout ----

function layout(domains) {
  const phases = [...new Set(domains.map((d) => d.phase))].sort((a, b) => a - b);
  const positions = {}; // concept id -> { cx, cy }
  const cards = []; // { domain, display_name, phase, x, y, w, h, count }

  let maxBottom = 0;
  phases.forEach((phase, colIndex) => {
    const x = MARGIN + colIndex * (COL_W + COL_GAP_X);
    let y = MARGIN + CARD_HEADER; // leave room for the phase title
    for (const d of domains.filter((dd) => dd.phase === phase)) {
      const concepts = domainConcepts(d);
      const h = cardHeight(concepts.length);
      cards.push({
        domain: d.domain,
        display_name: d.display_name,
        phase,
        x,
        y,
        w: COL_W,
        h,
        count: concepts.length,
      });
      concepts.forEach((c, i) => {
        const row = Math.floor(i / NODES_PER_ROW);
        const col = i % NODES_PER_ROW;
        positions[c.id] = {
          cx: x + CARD_PAD + col * (NODE + NODE_GAP) + NODE / 2,
          cy: y + CARD_HEADER + CARD_PAD + row * (NODE + NODE_GAP) + NODE / 2,
        };
      });
      y += h + CARD_GAP_Y;
      maxBottom = Math.max(maxBottom, y);
    }
  });

  const width = MARGIN + phases.length * (COL_W + COL_GAP_X) - COL_GAP_X + MARGIN;
  const height = maxBottom + MARGIN;
  return { phases, cards, positions, width, height };
}

// Aggregate prerequisite edges to the domain level (informational, readable).
function domainEdges(domains) {
  const byConcept = {};
  for (const d of domains) {
    for (const c of domainConcepts(d)) byConcept[c.id] = d.domain;
  }
  const seen = new Set();
  const edges = [];
  for (const d of domains) {
    for (const c of domainConcepts(d)) {
      for (const p of c.prerequisites ?? []) {
        const from = byConcept[p];
        const to = d.domain;
        if (from && to && from !== to) {
          const key = `${from}->${to}`;
          if (!seen.has(key)) {
            seen.add(key);
            edges.push({ from, to });
          }
        }
      }
    }
  }
  return edges;
}

// ---- Emit SVG ----

const PHASE_TITLES = {
  1: "Phase 1 · Foundations",
  2: "Phase 2 · Calculus & Linear Algebra",
  3: "Phase 3 · Classical & Modern Physics",
  4: "Phase 4 · Astrophysics",
};

function render(domains) {
  const { phases, cards, positions, width, height } = layout(domains);
  const edges = domainEdges(domains);
  const cardCenter = (name) => {
    const c = cards.find((cc) => cc.domain === name);
    return c ? { x: c.x + c.w / 2, y: c.y + c.h / 2, c } : null;
  };

  // Build the plain-text description first, then escape ONCE on emit (avoids
  // double-escaping "&" into "&amp;amp;").
  const phaseList = phases.map((p) => PHASE_TITLES[p] ?? `Phase ${p}`).join("; ");
  const altParts = cards.map(
    (c) => `${c.display_name} (${c.count} concepts, phase ${c.phase})`,
  );

  const edgeSvg = edges
    .map((e) => {
      const a = cardCenter(e.from);
      const b = cardCenter(e.to);
      if (!a || !b) return "";
      // Anchor edges to card right/left mid-points for a cleaner read.
      const x1 = a.c.x + a.c.w;
      const y1 = a.c.y + a.c.h / 2;
      const x2 = b.c.x;
      const y2 = b.c.y + b.c.h / 2;
      const mx = (x1 + x2) / 2;
      return `<path d="M${x1.toFixed(1)},${y1.toFixed(1)} C${mx.toFixed(1)},${y1.toFixed(1)} ${mx.toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}" fill="none" stroke="rgb(var(--color-surface-border))" stroke-width="1.5" opacity="0.7"/>`;
    })
    .join("\n");

  const phaseTitleSvg = phases
    .map((p, i) => {
      const x = MARGIN + i * (COL_W + COL_GAP_X);
      return `<text x="${x}" y="${MARGIN - 6}" font-size="13" font-weight="600" fill="rgb(var(--color-text))">${escapeXml(PHASE_TITLES[p] ?? `Phase ${p}`)}</text>`;
    })
    .join("\n");

  const cardSvg = cards
    .map(
      (c) =>
        `<g>` +
        `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="10" ` +
        `fill="rgb(var(--color-surface-raised))" stroke="rgb(var(--color-surface-border))" stroke-width="1"/>` +
        `<text x="${c.x + CARD_PAD}" y="${c.y + 17}" font-size="11" font-weight="600" fill="rgb(var(--color-text))">${escapeXml(c.display_name)}</text>` +
        `</g>`,
    )
    .join("\n");

  // Static concept nodes (neutral). Live status is overlaid by the React layer
  // using the positions sidecar — these baseline dots keep the SVG meaningful
  // on its own (e.g. when rendered via <img>).
  const nodeSvg = Object.values(positions)
    .map(
      (p) =>
        `<circle cx="${p.cx.toFixed(1)}" cy="${p.cy.toFixed(1)}" r="${NODE / 2}" fill="rgb(var(--color-surface-muted))"/>`,
    )
    .join("");

  const titleText = "Etta curriculum map";
  const descText = `Etta curriculum across ${cards.length} domains in ${phases.length} phases. ${phaseList}. Domains: ${altParts.join(", ")}.`;

  // Responsive sizing (#38): the SVG fills its container width but never grows
  // past its natural pixel size, and its height tracks the aspect ratio. The
  // viewBox is preserved so the React status-dot overlay aligns exactly.
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" height="auto" style="max-width:${width}px;height:auto;display:block" role="img" aria-labelledby="etta-map-title etta-map-desc" preserveAspectRatio="xMidYMid meet">
  <title id="etta-map-title">${escapeXml(titleText)}</title>
  <desc id="etta-map-desc">${escapeXml(descText)}</desc>
  <g class="etta-map-edges">
${edgeSvg}
  </g>
  <g class="etta-map-phase-titles">
${phaseTitleSvg}
  </g>
  <g class="etta-map-cards">
${cardSvg}
  </g>
  <g class="etta-map-nodes">${nodeSvg}</g>
</svg>
`;
}

function main() {
  const domains = loadDomains();
  const { positions, width, height } = layout(domains);
  const svg = render(domains);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "curriculum-map.svg"), svg, "utf8");
  writeFileSync(
    join(OUT_DIR, "curriculum-map-positions.json"),
    JSON.stringify({ width, height, positions }, null, 2),
    "utf8",
  );
  const count = Object.keys(positions).length;
  console.log(`curriculum-map.svg written (${count} concepts, ${domains.length} domains, ${width}x${height})`);
}

main();
