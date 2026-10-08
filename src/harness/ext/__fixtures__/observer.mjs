// D1 observe 事件 fixture: after_node 落盘可观察; on_verdict 刻意崩 (语义要求崩溃不扰动)。
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default (api) => {
  api.on('after_node', (e) => {
    writeFileSync(join(process.cwd(), 'observed-after_node.json'), JSON.stringify(e));
  });
  api.on('on_verdict', () => {
    throw new Error('observer-crash (刻意)');
  });
};
