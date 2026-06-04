/**
 * src/wright/curator — 通用减熵机器 (Phase 2: purify 的实体无关泛化)。
 * curate<T> + CuratorAdapter<T> 接口; skill-adapter 是首个 consumer (gene/fact 后续)。
 */
export { curate } from './curate';
export { cosine, clusterByCosine } from './cluster';
export type {
  CuratorAdapter,
  CurateResult,
  CurateOptions,
  CurateReducerOutcome,
  CurateShrink,
} from './types';
