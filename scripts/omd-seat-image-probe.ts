/**
 * scripts/omd-seat-image-probe —— 引擎座位图片载荷探针 (交接 47 票 5 前置; **不改引擎**)。
 *
 * 目的: 引擎座位传输层能否把**图片**带到多模态座位 `opencode-go:mimo-v2.5`?
 * omd-video 走独立 python 管线绕开了这条路径, 此格从未实测。
 *
 * 本探针**程序生成**一张已知内容 PNG (320x96 白底深字, 内置 5x7 位图字体画出
 * 短语 `SEAT-PROBE-7X9Q`, 零依赖: node:zlib deflateSync 压 IDAT + 自带 CRC32,
 * 不从盘上读现成图), 经 callModel 发**一发** (maxRetries: 0, retryDelayMs: 0),
 * 看模型能否复述短语。
 *
 * ## 预声明三态信号 (跑之前写死, 判词只从这三态里选, 不许跑完再补)
 *
 * - **通**   = 回答含预埋短语 (逐字或仅大小写差);
 * - **不通** = 传输层报错 (非 429 类: config 错 / 其他 4xx / 5xx / 超时)
 *              或模型回答表明未收到图 (称没有图 / 只见文字 / 复述不出且描述与图无关);
 * - **不可用** = 429 / 座位熔断冷却 / provider 不可用;
 * - **判不了** = 其余情况 (有回答但无法判定是否收到图) → 原始回答全文贴出并标「判不了」, 不许硬归。
 *
 * 三态**分开记, 不许混**。
 *
 * 代码侧的确定性判词规则 (与上文一致, 让机器可执行):
 *   调用抛错: status=429 或消息含 冷却/熔断/cool/unavailable → 不可用; 其余错误 → 不通;
 *   回答含 seat-probe-7x9q (忽略大小写) → 通;
 *   回答出现「没有图/没收到图/看不到图/没有图片/no image/只见文字/only text」→ 不通;
 *   其余 (有回答但判不了) → 判不了。
 *
 * ## 用法
 *
 *   bun run scripts/omd-seat-image-probe.ts
 *
 * 只发一发 (mimo 在 429 敏感期), 不重试不循环; **任何情况下 exit 0**
 * (失败信息体现在输出里, 不靠退出码)。判词行: `VERDICT: 通|不通|不可用|判不了`。
 */

import { deflateSync } from 'node:zlib';
import { callModel } from '../src/model';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import type { ContentPart } from '../src/model/types';

/** 预埋短语 — 程序生成进 PNG 像素, 判「通」的唯一基准。 */
const PHRASE = 'SEAT-PROBE-7X9Q';

const WIDTH = 320;
const HEIGHT = 96;
/** 5x7 字形放大倍数 (字形数据仍是 5x7, 放大只为了视觉模型好 OCR)。 */
const SCALE = 2;
const FG: readonly [number, number, number] = [18, 18, 18]; // 深字
const BG: readonly [number, number, number] = [255, 255, 255]; // 白底

/** 内置 5x7 位图字体 — 只硬编码本短语用到的字形 + 空格, 每字形 7 行 × 5 位 ('1'=涂黑)。 */
/** 空格字形 (FONT 查找 miss 时也用它兜底)。 */
const SPACE_GLYPH: readonly string[] = ['00000', '00000', '00000', '00000', '00000', '00000', '00000'];

const FONT: Record<string, readonly string[]> = {
  S: ['01110', '10001', '10000', '01110', '00001', '10001', '01110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  ' ': SPACE_GLYPH,
};

// ── PNG 编码 (零依赖: 手写 chunk + CRC32, IDAT 用 node:zlib deflateSync) ──────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf.readUInt8(i)) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** PNG chunk = 4B 长度 + type + data + CRC32 (over type+data)。 */
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** 8-bit RGB (color type 2) PNG: 签名 + IHDR + IDAT + IEND。 */
function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const stride = width * 3;
  // 每条 scanline 前置 filter byte 0 (None)。
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

/** 白底 + 深色 5x7 位图短语, 居中。返回完整 PNG buffer。 */
function renderProbePng(): Buffer {
  const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    rgb[i * 3] = BG[0];
    rgb[i * 3 + 1] = BG[1];
    rgb[i * 3 + 2] = BG[2];
  }
  const pitch = 6 * SCALE; // 每字符 5 列 + 1 列间距
  const textW = PHRASE.length * pitch - SCALE; // 去掉末字符尾间距
  const x0 = Math.floor((WIDTH - textW) / 2);
  const y0 = Math.floor((HEIGHT - 7 * SCALE) / 2);
  for (let ci = 0; ci < PHRASE.length; ci++) {
    const rows = FONT[PHRASE[ci] ?? ' '] ?? SPACE_GLYPH;
    for (let gy = 0; gy < 7; gy++) {
      const row = rows[gy]!;
      for (let gx = 0; gx < 5; gx++) {
        if (row[gx] !== '1') continue;
        for (let sy = 0; sy < SCALE; sy++) {
          for (let sx = 0; sx < SCALE; sx++) {
            const o = ((y0 + gy * SCALE + sy) * WIDTH + (x0 + ci * pitch + gx * SCALE + sx)) * 3;
            rgb[o] = FG[0];
            rgb[o + 1] = FG[1];
            rgb[o + 2] = FG[2];
          }
        }
      }
    }
  }
  return encodePng(WIDTH, HEIGHT, rgb);
}

// ── 判词 (规则与顶部预声明一致) ────────────────────────────────────────────────

interface ProbeError {
  kind?: string;
  status?: number;
  message?: string;
}

function verdictFor(err: ProbeError | undefined, answer: string | undefined): string {
  if (err) {
    if (err.status === 429) return '不可用';
    if (/冷却|熔断|cool|cooldown|unavailable|not available/i.test(err.message ?? '')) return '不可用';
    return '不通';
  }
  const ans = answer ?? '';
  if (/seat-probe-7x9q/i.test(ans)) return '通';
  if (/没有图|没收到图|没有收到图|看不到图|没有图片|no image|只见文字|only text|only saw text/i.test(ans)) {
    return '不通';
  }
  return '判不了';
}

// ── 主流程: bootstrap → 发一发 → 输出结构化证据 + 判词 ────────────────────────

if (import.meta.main) {
  // ⚠ 短命进程必须先 bootstrap (同 omd-seat-probe 的教训): 不注册 provider 会
  // `provider not registered` 假阴性 —— 一个会给假阴性的探针比没有探针更坏。
  bootstrapModelRuntime();

  const png = renderProbePng();
  const parts: ContentPart[] = [
    { type: 'text', text: '图里有一句短语, 原样复述它, 不要翻译' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
  ];

  const t0 = Date.now();
  let answer: string | undefined;
  let err: ProbeError | undefined;
  try {
    const res = await callModel({
      messages: [{ role: 'user', content: parts }],
      model: 'opencode-go:mimo-v2.5',
      maxRetries: 0,
      retryDelayMs: 0,
    });
    answer = res.text;
  } catch (e) {
    const me = e as { kind?: string; status?: number; message?: string };
    err = {
      ...(me.kind !== undefined ? { kind: me.kind } : {}),
      ...(me.status !== undefined ? { status: me.status } : {}),
      message: String(me.message ?? e),
    };
  }
  const ms = Date.now() - t0;

  const verdict = verdictFor(err, answer);

  console.log('=== omd-seat-image-probe ===');
  console.log(`模型: opencode-go:mimo-v2.5`);
  console.log(`预埋短语: ${PHRASE}`);
  console.log(
    `请求形: content parts = ${parts.length} (text + image_url) · 图片原始字节 = ${png.length} (PNG ${WIDTH}x${HEIGHT} RGB, data:image/png;base64)`,
  );
  console.log(`耗时: ${ms} ms`);
  console.log(
    `错误: ${err ? `kind=${err.kind ?? '?'} status=${err.status ?? '?'} message=${err.message}` : '无'}`,
  );
  console.log('原始回答全文:');
  console.log(answer ?? '(无回答 — 调用抛错, 见上行错误)');
  console.log(`VERDICT: ${verdict}`);
  process.exit(0); // 任何情况 exit 0 — 判词与证据都在 stdout 里, 不靠退出码。
}
