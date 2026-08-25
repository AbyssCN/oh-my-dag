/**
 * src/harness/web/url-guard —— fetchRacing 入口 SSRF 闸 (C1, 2026-08-25 台账)。
 *
 * 设计:fail-closed + 响亮抛错 (错误文案含 `SSRF`, 上游 probe/retrieve 走既有 fetch 失败留痕路径)。
 * 单一入口:fetchRacing 对每个目标 URL 先过本闸, 再分派 provider → 私网/环回/链路本地/CGNAT
 * 永远不会离开本进程。
 *
 * ## 范围
 * - **进本闸**:仅 http/https scheme;IP 字面量直接判;域名走 DNS 解析后**每个**地址判。
 * - **不进本闸**:redirect 逐跳复检 (plain `redirect:'follow'` 在 fetch 内部, 见台账未决);远端 provider
 *   (jina/firecrawl/crawl4ai) 自身 SSRF —— 打的是它们基础设施, 拦不到也不归本闸。
 *
 * ## IP 判定
 * - v4 走 `isIpv4InRanges` (CIDR 整数比);v6 走 `isIpv6InRanges`。
 * - v4-mapped v6 (`::ffff:a.b.c.d`) 还原为 v4 后复判, 防绕路。
 * - host 字面 `localhost` (大小写不敏感) 不经 DNS, 直接拒 (loopback 在 resolver 路径上可能被
 *   解析到 127.0.0.1, 但客户端给的字面 `localhost` 是更显式的信号, 显式拒)。
 *
 * ## 测试密封
 * `opts.resolver(hostname) → string[]` 可注入, 单元测试不打真 DNS。
 */
import { lookup } from 'node:dns/promises';

/* ─── 私网/环回网段清单 (契约钉名, O-6 锚) ─────────────────────── */

/** v4 CIDR + v6 CIDR, 每个条目 = `[family, [bits], startInt, endInt]`。 */
export type RangeEntry =
  | { family: 'v4'; cidr: string; start: number; end: number }
  | { family: 'v6'; cidr: string; start: bigint; end: bigint };

/**
 * 私网/环回/链路本地/未指定/CGNAT 网段 (台账 C1 钉版)。
 * v4: `0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16`。
 * v6: `::/128 ::1/128 fc00::/7 fe80::/10` + v4-mapped 还原后复判。
 */
export const PRIVATE_RANGES: readonly RangeEntry[] = Object.freeze([
  { family: 'v4', cidr: '0.0.0.0/8', start: 0x00000000, end: 0x00ffffff },
  { family: 'v4', cidr: '10.0.0.0/8', start: 0x0a000000, end: 0x0affffff },
  { family: 'v4', cidr: '100.64.0.0/10', start: 0x64400000, end: 0x647fffff },
  { family: 'v4', cidr: '127.0.0.0/8', start: 0x7f000000, end: 0x7fffffff },
  { family: 'v4', cidr: '169.254.0.0/16', start: 0xa9fe0000, end: 0xa9feffff },
  { family: 'v4', cidr: '172.16.0.0/12', start: 0xac100000, end: 0xac1fffff },
  { family: 'v4', cidr: '192.168.0.0/16', start: 0xc0a80000, end: 0xc0a8ffff },
  { family: 'v6', cidr: '::/128', start: 0n, end: 0n },
  { family: 'v6', cidr: '::1/128', start: 1n, end: 1n },
  { family: 'v6', cidr: 'fc00::/7', start: 0xfc000000000000000000000000000000n, end: 0xfdffffffffffffffffffffffffffffffn },
  { family: 'v6', cidr: 'fe80::/10', start: 0xfe800000000000000000000000000000n, end: 0xfebfffffffffffffffffffffffffffffn },
]);

/* ─── IP 解析 + CIDR 比对 ────────────────────────────────────── */

/** v4 字面 → 32 位整数;非 v4 返 null。 */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const seg = Number(p);
    if (!Number.isInteger(seg) || seg < 0 || seg > 255 || String(seg) !== p) return null;
    n = (n * 256) + seg;
  }
  return n >>> 0;
}

/** v6 字面 → 128 位 bigint;非 v6 返 null。v4-mapped (`::ffff:a.b.c.d`) 一律还原为 v4 比对。 */
function ipv6ToBigInt(ip: string): { v6: bigint } | { v4: number } | null {
  // v4-mapped (含 ::ffff:0:0/96 与 ::ffff:a.b.c.d 两种写法) → 还原为 v4
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) {
    const v4 = ipv4ToInt(mapped[1]!);
    if (v4 !== null) return { v4 };
  }
  const mappedHex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1]!, 16);
    const lo = Number.parseInt(mappedHex[2]!, 16);
    if (!Number.isInteger(hi) || !Number.isInteger(lo)) return null;
    const oct1 = (hi >> 8) & 0xff;
    const oct2 = hi & 0xff;
    const oct3 = (lo >> 8) & 0xff;
    const oct4 = lo & 0xff;
    const v4 = ipv4ToInt(`${oct1}.${oct2}.${oct3}.${oct4}`);
    if (v4 !== null) return { v4 };
  }
  // 通用 v6 解析 (parseIpv6/groupsToBigInt 全路径返 null 无可抛点 —— 不包 try/catch, 沉默 catch 绊线管着)
  // zone id (%eth0) 之类先剥离
  const noZone = ip.split('%')[0]!;
  const n = parseIpv6(noZone);
  if (n === null) return null;
  return { v6: n };
}

/** 解析 v6 字面 → 128 位 bigint;失败 null。处理 :: 缩写。 */
function parseIpv6(ip: string): bigint | null {
  if (ip.length === 0) return null;
  const dblCol = ip.split('::');
  if (dblCol.length > 2) return null;
  let head: string[] = [];
  let tail: string[] = [];
  if (dblCol.length === 2) {
    head = dblCol[0] ? dblCol[0].split(':') : [];
    tail = dblCol[1] ? dblCol[1].split(':') : [];
    if (head.length + tail.length > 7) return null;
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    const mid: string[] = [];
    for (let i = 0; i < fill; i++) mid.push('0');
    const full = [...head, ...mid, ...tail];
    if (full.length !== 8) return null;
    return groupsToBigInt(full);
  }
  const groups = ip.split(':');
  if (groups.length !== 8) return null;
  return groupsToBigInt(groups);
}

function groupsToBigInt(groups: string[]): bigint | null {
  let n = 0n;
  for (const g of groups) {
    if (g.length === 0 || g.length > 4) return null;
    const v = Number.parseInt(g, 16);
    if (!Number.isInteger(v)) return null;
    n = (n << 16n) | BigInt(v);
  }
  return n;
}

/** v4 字面是否落在 v4 私网段。 */
function isIpv4InRanges(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  for (const r of PRIVATE_RANGES) {
    if (r.family === 'v4' && n >= r.start && n <= r.end) return true;
  }
  return false;
}

/** v6 字面是否落在 v6 私网段;v4-mapped 转 v4 复判。 */
function isIpv6InRanges(ip: string): boolean {
  const parsed = ipv6ToBigInt(ip);
  if (parsed === null) return false;
  if ('v4' in parsed) return isIpv4InRangesInt(parsed.v4);
  for (const r of PRIVATE_RANGES) {
    if (r.family === 'v6' && parsed.v6 >= r.start && parsed.v6 <= r.end) return true;
  }
  return false;
}

/** v4 整数比 (跳过字面解析, 给 v4-mapped 还原后用)。 */
function isIpv4InRangesInt(n: number): boolean {
  for (const r of PRIVATE_RANGES) {
    if (r.family === 'v4' && n >= r.start && n <= r.end) return true;
  }
  return false;
}

/* ─── public API ──────────────────────────────────────────── */

export interface AssertPublicUrlOpts {
  /**
   * 注入式 DNS 解析 — 默认 `node:dns/promises` 的 `lookup(host, { all: true })`。
   * 测试密封:fake resolver 直接返字面 IP 列表, 不打真 DNS。
   */
  resolver?: (hostname: string) => Promise<Array<{ address: string }>>;
}

/**
 * 闸拒 = throw `Error('SSRF guard: ...')`, 错误文案固定含 `SSRF` (上游可机械 grep 留痕)。
 * 闸内容:仅 http/https;host 为 IP 字面量直接判;域名走 DNS 后**每个**地址判;`localhost` 字面拒。
 */
export async function assertPublicUrl(url: string, opts: AssertPublicUrlOpts = {}): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`SSRF guard: not a valid URL (got: ${url})`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`SSRF guard: url must be http(s) (got: ${parsed.protocol.replace(':', '')}://)`);
  }

  const host = parsed.hostname;
  if (host.length === 0) {
    throw new Error(`SSRF guard: empty host (got: ${url})`);
  }

  // 字面 `localhost` 直接拒 (大小写不敏感)
  if (host.toLowerCase() === 'localhost') {
    throw new Error(`SSRF guard: "localhost" resolves to loopback (${url})`);
  }

  // IP 字面: 直接判, 不走 DNS
  // URL.hostname 对 v6 字面常保留 `[...]` 包裹 (WHATWG URL 规范), 先剥壳
  const hostStripped = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const looksLikeIpLiteral =
    /^[\[\]:0-9a-f.]+$/i.test(host) ||
    host.includes(':') ||
    host.startsWith('[');
  if (looksLikeIpLiteral) {
    // IPv6 字面常带 [] 包裹 (URL.hostname 已经去掉)
    if (isIpv4InRanges(hostStripped) || isIpv6InRanges(hostStripped)) {
      throw new Error(`SSRF guard: target IP in private/loopback range (${url})`);
    }
    return;
  }

  // 域名: 走 DNS。
  // 解析失败/零地址 = **放行**, 不是拒: 解析失败不是"目标在私网"的证据 —— 真实 fetch 对同一
  // 主机同样解析不了、够不着任何东西, 放行不构成 SSRF 绕过; 而拒会把离线/假域名场景全砸
  // (实测 run 960c5107: 该分支写成抛错, 3 条既有 probe 测试的 fake 主机全红)。
  // fail-closed 只对"证实私网"。已知残余: DNS rebinding (解析时公网、fetch 时私网) 不在本闸射程, 见契约未决。
  const resolver = opts.resolver ?? defaultResolver;
  let addrs: Array<{ address: string }>;
  try {
    addrs = await resolver(host);
  } catch (e) {
    // fail-open 但留证据 (仓规: 吞异常不许吞证据) —— 放行判断要能事后查。
    process.stderr.write(`[url-guard] DNS lookup failed for ${host} → 放行 (非私网证据): ${(e as Error).message}\n`);
    return;
  }
  if (addrs.length === 0) {
    return;
  }
  for (const { address } of addrs) {
    // 每条地址单独判 (v4 字面 + v6 字面 + v4-mapped v6)
    if (looksLikeIpLiteralString(address) || address.includes(':')) {
      if (isIpv4InRanges(address) || isIpv6InRanges(address)) {
        throw new Error(`SSRF guard: ${host} resolves to private/loopback address ${address} (${url})`);
      }
    } else {
      if (isIpv4InRanges(address)) {
        throw new Error(`SSRF guard: ${host} resolves to private/loopback address ${address} (${url})`);
      }
    }
  }
}

/** 形如 IP 字面 (含 v4 各段数字 / v6 hex / v4-mapped) 的快速判断。 */
function looksLikeIpLiteralString(s: string): boolean {
  return /^[\[\]:0-9a-f.]+$/i.test(s);
}

/** 默认 resolver: node DNS lookup all, 返 {address, family} 列表 (我们只用 address)。 */
async function defaultResolver(hostname: string): Promise<Array<{ address: string }>> {
  const r = await lookup(hostname, { all: true });
  return r.map((e) => ({ address: e.address }));
}
