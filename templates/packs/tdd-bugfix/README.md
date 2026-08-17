# omd-pack-tdd-bugfix —— 参考 pack(照抄这个结构)

TDD 修 bug 纪律的完整 pack:**复现红 → 最小修复 → 回归绿**。它同时是 pack 作者的参考模板:
一个"完整"的 pack 长什么样、每一件东西被哪道闸背书、能力主张怎么证明。

## 装

```sh
omd pack add templates/packs/tdd-bugfix   # 本地路径; 发布后换 git URL
omd pack remove omd-pack-tdd-bugfix       # 卸载 (byte 级回到装前)
```

## 内容物与层级(pack = 分发容器,内容物作用在不同层)

| 件 | 层级 | 这里装的 |
|---|---|---|
| **playbook**(剧本) | run 级:轮次怎么推进、怎么算收敛 | `tdd-bugfix`:三步链 + loop≤3 + 自证判据 `bun test` |
| **agent 卡**(角色卡) | 节点级:图上某个节点谁来做 | `bug-reproducer`(只写红测试)/`minimal-fixer`(最小修复禁改测试) |
| **skill**(手册) | 按需:leaf 经 read_skill 取 | `bugfix-triage` 定位方法论 |
| **eval**(能力证明) | 包作者自己的义务,**不随 pack 安装** | 种 bug fixture + 隐藏 oracle + 四要素 PLAN(读数表未跑先空着) |

## 每件东西被哪道闸背书(这是 pack 与"一堆 prompt 文件"的区别)

| 时刻 | 闸 | 对本 pack 意味着 |
|---|---|---|
| 安装期 | A-1/A-2/A-3(playbook 三道闸) | `acceptance.command` 在 `seeded-red.test.ts` 错样本世界里**真跑过且真失败过**才装得进 —— 判据被证明有判别力 |
| 安装期 | 卡校验 + 卡名冲突闸 | 两张卡装得出、不与项目层/他包同名静默覆盖 |
| 安装期 | 知情回执 | 卡名/描述/playbook 判据/内容哈希打给安装者过目(卡是 prompt 载荷,add 即信任) |
| 规划期 | parsePlan 未知卡拒 | conductor 只能派注册表里的卡 |
| 执行期 | verify-red(`expect_exit: 1`)| "复现测试是红的"由退出码证明,不由自述证明 |
| 执行期 | 产物闸 / 全量回归步 | 空修复、改测试作弊、引入回归都有人抓 |
| 事后 | eval 隐藏 oracle | 能力主张 = 读数表,不是 README 形容词 |

## 对 pack 作者的三条硬要求(从本模板继承)

1. **playbook 的判据必须自证**:acceptance 命令在你自带的错样本上不失败,装不进 —— 别写 `true`。
2. **卡的承诺尽量翻成闸**:bug-reproducer 的承诺不是"我会认真复现",是"后面跟一个
   `expect_exit:1` 的 command 节点";写不成闸的承诺按未验对待。
3. **能力主张 = eval 读数表**:PLAN.md 四要素先写死(单一变量/预声明信号/同条件基线/两侧都记),
   跑完把表填上;空表期间不许在 README 里写"显著提升"。
