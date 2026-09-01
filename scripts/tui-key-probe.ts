/**
 * scripts/tui-key-probe —— **按键字节探针**(`src/tui/keys.ts` 文首提到的那只)。
 *
 * 用 pi-tui 自己的 `ProcessTerminal`(与 omd TUI 同一条输入链: StdinBuffer 切分 +
 * kitty / modifyOtherKeys 协商)把送到 input handler 的**每一段序列**逐字节打出来,
 * 并标注它命中了哪个 omd 键位(`omd.dagFull` / `omd.pathFull` / …)。
 *
 * 用途: 排查「没按 Ctrl+G / Ctrl+P, 全屏视图却自己开了」—— 切终端 tab / 切窗口焦点时
 * 到底送进来什么字节。别推, 去看。
 *
 *   bun run scripts/tui-key-probe.ts
 *   (切几次 tab, 按几个键, 再按 q 或 Ctrl+C 退出)
 */
import { KeybindingsManager, ProcessTerminal, isKeyRelease, parseKey, setKeybindings } from '@earendil-works/pi-tui';
import { OMD_KEYBINDINGS } from '../src/tui/keys';

const kb = new KeybindingsManager(OMD_KEYBINDINGS);
setKeybindings(kb);
const term = new ProcessTerminal();

const hex = (s: string): string => [...s].map((c) => c.codePointAt(0)!.toString(16).padStart(2, '0')).join(' ');
let n = 0;
term.start(
  (data: string) => {
    n += 1;
    const hits = Object.keys(OMD_KEYBINDINGS).filter((id) => kb.matches(data, id as keyof typeof OMD_KEYBINDINGS));
    const line =
      `#${n} ${new Date().toISOString().slice(11, 23)} bytes=[${hex(data)}] json=${JSON.stringify(data)} ` +
      `parseKey=${parseKey(data) ?? '-'} release=${isKeyRelease(data)} ` +
      `kitty=${term.kittyProtocolActive} mok=${term.modifyOtherKeysActive} hits=${hits.length ? hits.join(',') : '-'}\r\n`;
    process.stdout.write(line);
    if (data === '\x03' || data === 'q') {
      term.stop();
      process.stdout.write('bye\r\n');
      process.exit(0);
    }
  },
  () => {},
);
process.stdout.write('key probe: switch tabs / press keys; q or Ctrl+C exits\r\n');
