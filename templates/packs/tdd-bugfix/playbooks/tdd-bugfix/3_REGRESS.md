# 第 3 步:全量回归(reset 步)

`executor: 'command'` 跑全量测试(acceptance 同款命令)。任何新红 = 修复引入回归,
本轮不收敛 —— loop 回到第 1 步(reset: 下一轮从干净判断开始,不背上一轮的中间结论)。

收敛判据由 playbook 的 acceptance 命令定(`bun test` 退出 0),不由任何一方口头宣布。
