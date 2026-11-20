# dsh-layout-governor

**一句话**：让工作区始终保持一张能读懂的地图——每个顶层条目都在册，每份文件都有一个家，Agent 的写入落在图上指着的位置。

插件就是一份「家具清单」加一道门：

- `layout.policy.yml` 是清单：哪些顶层目录合法、什么算备份、哪些路径受保护。
- 门在写入落地之前判定：新顶层条目先登记，再落地。

职责范围很窄：目录与文件的归属。代码与符号查询由 `codegraph` 承担，版本历史由 git 承担。

## 它做四件事

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 写入前判定 | `tools/pre-execute`、`fs/write-intent`、`fs/edit-intent` | 新顶层条目按清单放行；已存在的目录照常可写 |
| 盘点现状 | `layout_audit` 工具、`POST /api/layout-governor/report`、CLI | 只读：走一遍树，给出 fail / warn 与每条规则的覆盖账目 |
| 给出修法 | `--fix-plan` | `review` / `edit-doc` / `register` / `move-to-archive`，按 risk 分档，高风险一律转人工 |
| 归档（可选，默认关） | `autofix.enabled: true` | 备份类文件移入 `_archive/YYYYMMDD_<来源>/`，附 `moves.jsonl` 与可回滚的 `undo.sh` |

## 清单长这样

```yaml
guard:
  enabled: true          # 门口这道闸

rules:
  top-level:
    allow: [writings, mining, video, game, _projects, _tools, _context]

classification:
  regenerable: ["**/.venv/**", "**/node_modules/**"]
  protected: ["writings/writer/**", "**/.codegraph*/**"]

autofix:
  enabled: false         # 先跑 --fix-plan 看过，再打开
```

## 三条硬线

1. **只读**：审计在受审的树上零写入。
2. **可回滚**：移动带 `undo.sh`，重名先占位，已有目标一律跳过并回报。
3. **按会话**：工作区从发起调用的会话解析，多工作区同时成立。

## 快速开始

```bash
# 看现状（只读）
node bin/layout-governor.mjs --root /mnt/d/studio --format text

# 看修法（不执行）
node bin/layout-governor.mjs --root /mnt/d/studio --fix-plan

# 门禁：任何非 pass 都退出 1
node bin/layout-governor.mjs --root /mnt/d/studio --check
```

装进 DSH：`dsh plugin --profile web install /path/to/layout-governor`，重启后生效。

## 相邻职责

代码与符号查询：`codegraph serve --mcp`。版本历史：git。本插件管「目录语义」。

## 文档

- [`docs/policy.md`](docs/policy.md) — 清单字段逐项说明
- [`docs/quality.md`](docs/quality.md) — 自审记录与实测数据
