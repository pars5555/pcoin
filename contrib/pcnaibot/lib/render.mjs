// Turning a model's answer into something Telegram can show.
//
// NO MODEL IN THIS POOL CAN GENERATE A RASTER IMAGE. Verified against the live
// registry: `supportsVision` is about a model READING an image, there is no
// generation capability anywhere, and the gateway is Anthropic-compatible
// /v1/messages, whose content blocks are text, thinking and tool_use -- never
// images. Asked for an icon, glm-5.3-flash said so itself: "Since I can't
// generate raster images."
//
// What a model CAN produce is SVG, which is an image, just a vector one. So the
// answer is rasterised here and sent as a real photo -- the user asked for an
// icon and gets a picture, rather than 3,000 characters of markup.
//
// A 32x32 icon is unreadable in a chat, so it is rendered larger. The SVG's own
// shape-rendering="crispEdges" keeps pixel art crisp rather than blurring it.

import { log, errFields } from './log.mjs';

export const RENDER_WIDTH = 512;
// Bound what we will rasterise. An SVG is a program: a pathological one can
// expand enormously, and this runs in a 512MB container shared with the money
// path.
export const MAX_SVG_BYTES = 256 * 1024;

const SVG_RE = /<svg[\s\S]*?<\/svg>/gi;

// Pull every complete <svg> element out of an answer.
export function extractSvgs(text) {
  if (typeof text !== 'string' || text.indexOf('<svg') === -1) return [];
  const out = [];
  for (const m of text.matchAll(SVG_RE)) {
    const svg = m[0];
    if (svg.length > MAX_SVG_BYTES) {
      log.warn('skipping an oversized SVG', { bytes: svg.length, cap: MAX_SVG_BYTES });
      continue;
    }
    out.push(svg);
  }
  return out;
}

// Rasterise to PNG. Returns null on any failure -- an image that will not
// render must never cost the user their answer, which is delivered separately
// either way.
export async function svgToPng(svg, { width = RENDER_WIDTH } = {}) {
  try {
    const { Resvg } = await import('@resvg/resvg-js');
    const r = new Resvg(svg, {
      fitTo: { mode: 'width', value: width },
      // No remote fetching. An SVG can reference external images, and this
      // process must not be turned into a fetcher for whatever a model emits.
      font: { loadSystemFonts: true },
    });
    const png = r.render().asPng();
    if (!png || png.length < 8) return null;
    return png;
  } catch (e) {
    log.warn('SVG did not rasterise; sending the answer as text only', errFields(e));
    return null;
  }
}

// Content blocks we do not know how to show.
//
// The answer extractor keeps only `text`, so anything else is silently dropped.
// That is correct for `thinking` -- the user did not ask to read the model's
// notes -- but anything ELSE being dropped is worth knowing about, because it
// means the pool grew a capability we are discarding.
export function unknownBlockTypes(content) {
  if (!Array.isArray(content)) return [];
  const known = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use', 'server_tool_use']);
  return [...new Set(content.map((c) => c?.type).filter((t) => t && !known.has(t)))];
}
