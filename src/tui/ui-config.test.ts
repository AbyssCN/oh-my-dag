/**
 * L1:界面/审批设置的 config 读写(切片⑥)。
 *
 * 反向自检:「坏 JSON 拒绝覆盖写」—— 把 patchOmdConfig 的抛错改成 `root = {}`,
 * 那条用例当场红(座位等别人写的段会被静默抹掉,那正是这条闸防的事故)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTuiUiConfig, patchOmdConfig, setApprovalTokenTtl, setTuiUi } from './ui-config';

const tdir = () => mkdtempSync(join(tmpdir(), 'omd-uicfg-'));

describe('loadTuiUiConfig', () => {
  test('没有文件 → 默认: 左栏开, 画法 0(树)', () => {
    expect(loadTuiUiConfig(tdir(), {})).toEqual({ sidebar: true, painterIdx: 0 });
  });

  test('读回写过的值; 非法 painter 名回落 0', () => {
    const dir = tdir();
    setTuiUi(dir, { sidebar: false, painterIdx: 1 }, {});
    expect(loadTuiUiConfig(dir, {})).toEqual({ sidebar: false, painterIdx: 1 });
    mkdirSync(join(dir, '.omd'), { recursive: true });
    writeFileSync(join(dir, '.omd', 'config.json'), JSON.stringify({ tui: { ui: { painter: 'nonsense' } } }));
    expect(loadTuiUiConfig(dir, {}).painterIdx).toBe(0);
  });
});

describe('写盘', () => {
  test('★ 读-改-写不抹别人的段(座位配置留着)', () => {
    const dir = tdir();
    mkdirSync(join(dir, '.omd'), { recursive: true });
    writeFileSync(join(dir, '.omd', 'config.json'), JSON.stringify({ models: { conductor: 'a:b' } }));
    setTuiUi(dir, { sidebar: false }, {});
    const root = JSON.parse(readFileSync(join(dir, '.omd', 'config.json'), 'utf8'));
    expect(root.models.conductor).toBe('a:b');
    expect(root.tui.ui.sidebar).toBe(false);
  });

  test('★ 坏 JSON 拒绝覆盖写(抛错, 不拿 {} 抹掉全部配置)', () => {
    const dir = tdir();
    mkdirSync(join(dir, '.omd'), { recursive: true });
    writeFileSync(join(dir, '.omd', 'config.json'), '{oops');
    expect(() => setTuiUi(dir, { sidebar: false }, {})).toThrow('refusing to overwrite');
    expect(readFileSync(join(dir, '.omd', 'config.json'), 'utf8')).toBe('{oops'); // 文件原样
  });

  test('setApprovalTokenTtl 写 tui.approvals.tokenTtlSec; 非正数拒', () => {
    const dir = tdir();
    setApprovalTokenTtl(dir, 120, {});
    const root = JSON.parse(readFileSync(join(dir, '.omd', 'config.json'), 'utf8'));
    expect(root.tui.approvals.tokenTtlSec).toBe(120);
    expect(() => setApprovalTokenTtl(dir, 0, {})).toThrow('positive number');
    expect(() => setApprovalTokenTtl(dir, Number.NaN, {})).toThrow('positive number');
  });

  test('patchOmdConfig 返回写的路径(回执要能说出改了哪个文件)', () => {
    const dir = tdir();
    const path = patchOmdConfig(dir, () => {}, {});
    expect(path).toBe(join(dir, '.omd', 'config.json'));
  });
});

describe('与审批闸的合流(切片①的 loadApprovalConfig 读同一段)', () => {
  test('★ 面板写的 TTL, 闸启动时读得到 —— 两处是同一个真源', async () => {
    const dir = tdir();
    setApprovalTokenTtl(dir, 42, {});
    const { loadApprovalConfig } = await import('./approval/policy');
    expect(loadApprovalConfig(dir, {}).tokenTtlSec).toBe(42);
  });
});
