// D1 体检反向 fixture: 订阅词表外事件 —— 加载必须被拒并点名 on:zzz_unknown_event。
export default (api) => {
  api.on('zzz_unknown_event', () => {});
};
