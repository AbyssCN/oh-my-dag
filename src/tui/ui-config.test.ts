/**
 * L1:界面设置的 config 读写(切片⑥)。
 *
 * 反向自检:「坏 JSON 拒绝覆盖写」—— 把 patchOmdConfig 的抛错改成 `root = {}`,
 * 那条用例当场红(座位等别人写的段会被静默抹掉,那正是这条闸防的事故)。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTuiUiConfig, patchOmdConfig, setTuiUi } from './ui-config';

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

  test('patchOmdConfig 返回写的路径(回执要能说出改了哪个文件)', () => {
    const dir = tdir();
    const path = patchOmdConfig(dir, () => {}, {});
    expect(path).toBe(join(dir, '.omd', 'config.json'));
  });
});

describe('与围栏配置的分段而治(2026-08-13)', () => {
  /**
   * ★ 这条钉的是**两个消费者不打架**:界面段(`tui.ui`)由本文件写,
   * 围栏段(`tui.sandbox`)由 `harness/hooks/command-policy` 读。
   * 之前 `tui.approvals` 是两边各读一份的,而那正是"同一段两处声明必漂"的原型。
   *
   * 证伪:把 `setTuiUi` 改成整段覆写 `root.tui = {ui}` → 这条当场红(围栏段被抹掉)。
   */
  test('★ 写界面段不碰围栏段 —— 面板改画法不该把沙箱配置抹掉', async () => {
    const dir = tdir();
    mkdirSync(join(dir, '.omd'), { recursive: true });
    writeFileSync(join(dir, '.omd', 'config.json'), JSON.stringify({ tui: { sandbox: { writable: ['/srv/x'] } } }));
    setTuiUi(dir, { sidebar: false }, {});
    const { loadSandboxConfig } = await import('../harness/hooks/command-policy');
    expect(loadSandboxConfig(dir, {}).writable).toEqual(['/srv/x']);
    expect(loadTuiUiConfig(dir, {}).sidebar).toBe(false);
  });
});
