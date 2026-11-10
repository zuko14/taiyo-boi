import 'server-only';
import bwipjs from 'bwip-js/node';

/** Code 128 of the human-readable registration code (staff scanning needs a staff session). */
export const code128Svg = (text: string) =>
  bwipjs.toSVG({ bcid: 'code128', text, height: 10, includetext: false });

/** QR containing only the portal URL with an opaque random token — no personal data. */
export const qrSvg = (text: string) => bwipjs.toSVG({ bcid: 'qrcode', text });
