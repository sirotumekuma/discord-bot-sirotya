import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';

// ===================== フォント登録 =====================
// fonts/ フォルダ内の .ttf / .otf / .ttc をすべて登録する（Noto Sans JP 推奨）
const FONT_DIR = path.resolve('fonts');
let fontCount = 0;
if (fs.existsSync(FONT_DIR)) {
  for (const f of fs.readdirSync(FONT_DIR)) {
    if (/\.(ttf|otf|ttc)$/i.test(f)) {
      if (GlobalFonts.registerFromPath(path.join(FONT_DIR, f))) fontCount++;
    }
  }
}
if (fontCount === 0) {
  console.warn(
    '[certificate] fonts/ に日本語フォントが見つかりません。' +
    'サーバーに日本語フォントが無いと、許諾証の文字が□（豆腐）になります。' +
    'NotoSansJP-Bold.ttf などを fonts/ に置いてください。',
  );
}

const fontStack = () => {
  const fam = process.env.CERT_FONT_FAMILY || 'Noto Sans JP';
  return `"${fam}", "Noto Sans CJK JP", "Yu Gothic", "Meiryo", sans-serif`;
};

// ===================== 文字の配置（画像サイズに対する割合）=====================
// 自前の certificate_template.png を使う場合は、ここの値を調整してください。
//   y     : 縦位置（0〜1、文字の縦中央）
//   size  : 基準フォントサイズ（画像の横幅に対する割合）
//   min   : 縮小の下限サイズ（同上）
//   maxW  : 文字を収める最大幅（画像の横幅に対する割合）
export const CERT_LAYOUT = {
  number: { x: 0.5, y: 0.43, size: 0.048, maxW: 0.8, color: '#1e293b' },
  site:   { x: 0.5, y: 0.60, size: 0.050, min: 0.026, maxW: 0.74, color: '#1e293b' },
  date:   { x: 0.5, y: 0.80, size: 0.030, maxW: 0.6, color: '#334155' },
};

const TEMPLATE_PATH = () =>
  path.resolve(process.env.CERT_TEMPLATE_PATH || 'assets/certificate_template.png');

// ===================== ロゴ取得（成功時のみキャッシュ）=====================
let logoCache = null;
async function getLogo() {
  if (logoCache) return logoCache;
  try {
    const res = await fetch(process.env.BADGE_IMAGE_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    logoCache = await loadImage(Buffer.from(await res.arrayBuffer()));
    return logoCache;
  } catch (e) {
    console.warn('[certificate] ロゴ画像の取得に失敗:', e.message);
    return null;
  }
}

// ===================== テキスト描画ヘルパー =====================
function wrapLines(ctx, text, maxWidth, maxLines) {
  const chars = [...text];
  const lines = [];
  let line = '';
  for (const ch of chars) {
    if (ctx.measureText(line + ch).width > maxWidth && line) {
      lines.push(line);
      line = ch;
      if (lines.length === maxLines) break;
    } else {
      line += ch;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);

  // 入りきらなかった場合は最終行を「…」で省略
  const consumed = lines.join('').length;
  if (consumed < chars.length) {
    let last = lines[lines.length - 1];
    while (last.length > 1 && ctx.measureText(last + '…').width > maxWidth) {
      last = last.slice(0, -1);
    }
    lines[lines.length - 1] = last + '…';
  }
  return lines;
}

/** 幅に収まるよう縮小 → それでも長ければ最大2行に折り返して描画 */
function drawFitted(ctx, text, { x, y, size, min, maxW, color, W, H, weight = 'bold' }) {
  const px = size * W;
  const minPx = (min ?? size) * W;
  const maxWidth = maxW * W;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  let cur = px;
  while (cur > minPx) {
    ctx.font = `${weight} ${Math.round(cur)}px ${fontStack()}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    cur -= 2;
  }
  cur = Math.max(cur, minPx);
  ctx.font = `${weight} ${Math.round(cur)}px ${fontStack()}`;

  if (ctx.measureText(text).width <= maxWidth) {
    ctx.fillText(text, x * W, y * H);
    return;
  }
  // 折り返し（2行）
  const lines = wrapLines(ctx, text, maxWidth, 2);
  const lh = cur * 1.25;
  const startY = y * H - ((lines.length - 1) * lh) / 2;
  lines.forEach((l, i) => ctx.fillText(l, x * W, startY + i * lh));
}

// ===================== テンプレートが無いときの標準デザイン =====================
async function drawDefaultTemplate(ctx, W, H) {
  ctx.fillStyle = '#fffdf7';
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = Math.round(W * 0.005);
  ctx.strokeRect(W * 0.025, W * 0.025, W - W * 0.05, H - W * 0.05);
  ctx.lineWidth = Math.round(W * 0.0015);
  ctx.strokeRect(W * 0.04, W * 0.04, W - W * 0.08, H - W * 0.08);

  const logo = await getLogo();
  if (logo) {
    const size = W * 0.075;
    ctx.drawImage(logo, W / 2 - size / 2, H * 0.06, size, size);
  }

  const text = (t, y, size, color, weight = 'bold') => {
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${weight} ${Math.round(size * W)}px ${fontStack()}`;
    ctx.fillText(t, W / 2, y * H);
  };

  text('sirotya 使用許諾証', 0.20, 0.052, '#1d4ed8');
  text('下記のWebサイトに対し、sirotyaの掲載・連携を許諾します。', 0.28, 0.019, '#475569', 'normal');
  text('許諾番号', 0.355, 0.018, '#64748b', 'normal');
  text('対象Webサイト', 0.515, 0.018, '#64748b', 'normal');
  text('発行日', 0.725, 0.018, '#64748b', 'normal');
  text('sirotya 許諾管理事務局', 0.92, 0.020, '#1e293b');
}

// ===================== 公開API =====================
/**
 * 許諾証PNGを生成して Buffer で返す。
 * @param {{siteName:string, licenseNumber:string, issuedAt:string|Date}} p
 *   licenseNumber は "SR-2026-001" 形式（「第 〜 号」は自動で付く）
 */
export async function generateCertificate({ siteName, licenseNumber, issuedAt }) {
  let canvas, ctx, W, H;

  if (fs.existsSync(TEMPLATE_PATH())) {
    const base = await loadImage(TEMPLATE_PATH());
    W = base.width;
    H = base.height;
    canvas = createCanvas(W, H);
    ctx = canvas.getContext('2d');
    ctx.drawImage(base, 0, 0, W, H);
  } else {
    W = 1600;
    H = 1131; // A4横の比率
    canvas = createCanvas(W, H);
    ctx = canvas.getContext('2d');
    await drawDefaultTemplate(ctx, W, H);
  }

  const dateJa = new Date(issuedAt).toLocaleDateString('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric',
  });

  const L = CERT_LAYOUT;
  drawFitted(ctx, `第 ${licenseNumber} 号`, { ...L.number, W, H });
  drawFitted(ctx, siteName, { ...L.site, W, H });
  drawFitted(ctx, dateJa, { ...L.date, W, H, weight: 'normal' });

  return await canvas.encode('png');
}
