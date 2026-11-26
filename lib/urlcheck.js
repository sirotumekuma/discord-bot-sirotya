import dns from 'node:dns/promises';
import net from 'node:net';

/** http:// または https:// で始まる正しいURLか */
export function isValidHttpUrl(str) {
  if (!/^https?:\/\//i.test(str)) return false;
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * 重複判定用の正規化。
 * http/https の違い・www の有無・末尾スラッシュ・#以降・ホスト名の大文字小文字を無視する。
 */
export function normalizeUrlForCompare(raw) {
  try {
    const u = new URL(String(raw).trim());
    const host = u.host.toLowerCase().replace(/^www\./, '');
    const p = u.pathname.replace(/\/+$/, '');
    return `${host}${p}${u.search}`;
  } catch {
    return String(raw).trim().toLowerCase().replace(/\/+$/, '');
  }
}

/** プライベート/ループバック等の内部アドレスか（SSRF対策） */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const l = ip.toLowerCase();
  return (
    l === '::1' || l === '::' ||
    l.startsWith('fc') || l.startsWith('fd') ||
    l.startsWith('fe80') || l.startsWith('::ffff:')
  );
}

async function requestOnce(url, method) {
  const res = await fetch(url, {
    method,
    redirect: 'manual',
    signal: AbortSignal.timeout(8000),
    headers: { 'User-Agent': 'sirotya-license-bot/2.0 (+url-check)' },
  });
  res.body?.cancel().catch(() => {});
  return res;
}

/**
 * URLの生存確認。
 * @returns {{ok:true,status:number,warning?:string}|{ok:false,reason:string}}
 * - 2xx: OK
 * - 3xx: 最大5回までリダイレクトを追跡
 * - 401/403/429: Bot拒否の可能性があるため OK 扱い（運営に警告として表示）
 * - それ以外のエラー・接続失敗: NG
 */
export async function checkUrl(startUrl) {
  let current = startUrl;

  for (let hop = 0; hop <= 5; hop++) {
    let u;
    try {
      u = new URL(current);
    } catch {
      return { ok: false, reason: 'URLの形式が正しくありません' };
    }
    if (!/^https?:$/.test(u.protocol)) {
      return { ok: false, reason: 'http/https 以外は利用できません' };
    }

    // DNS解決 & 内部アドレス拒否
    let addrs;
    try {
      addrs = net.isIP(u.hostname)
        ? [{ address: u.hostname }]
        : await dns.lookup(u.hostname, { all: true });
    } catch {
      return { ok: false, reason: 'ドメインが見つかりません' };
    }
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
      return { ok: false, reason: 'このアドレスは利用できません' };
    }

    // HEAD → だめならGETで再試行
    let res;
    try {
      res = await requestOnce(current, 'HEAD');
      if (res.status >= 400) res = await requestOnce(current, 'GET');
    } catch {
      try {
        res = await requestOnce(current, 'GET');
      } catch {
        return { ok: false, reason: '接続できませんでした（タイムアウトまたは接続エラー）' };
      }
    }

    const s = res.status;
    if (s >= 200 && s < 300) return { ok: true, status: s };
    if (s >= 300 && s < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { ok: false, reason: `HTTP ${s}（転送先が不明）` };
      current = new URL(loc, current).toString();
      continue;
    }
    if (s === 401 || s === 403 || s === 429) {
      return { ok: true, status: s, warning: 'Botのアクセスを拒否している可能性があります' };
    }
    return { ok: false, reason: `HTTP ${s}` };
  }
  return { ok: false, reason: 'リダイレクトが多すぎます' };
}

export function formatCheck(check) {
  if (!check) return '未実施';
  if (check.warning) return `⚠️ HTTP ${check.status}（${check.warning}）`;
  return `✅ HTTP ${check.status}`;
}
