# AI 简历 · 可辩护的 JD 匹配器（简版）

一次录入真实经历，粘贴 JD 定向生成简历。每条亮点都能追溯到用户原话，并附面试追问；找不到依据的内容不写进简历。

## 功能流程

1. `/collect` 对话录入：模型追问细节和数字，"整理入库"时拆成原子事实，每条事实的 `source` 必须逐字出现在用户发言里，否则丢弃
2. `/vault` 履历库：编辑、删除、手动补充事实；导出/导入 JSON 备份
3. `/match` 粘贴 JD：生成"JD 要求 ↔ 事实"匹配表，没有依据的要求标为缺口
4. `/resume` 定向简历：亮点必须引用事实，且亮点中的数字必须出现在所引事实中，否则剔除并说明原因；浏览器打印导出 PDF

数据只存在浏览器 localStorage，没有登录和数据库。

## 本地运行

```bash
npm install
cp .env.example .env.local   # 填入 LLM_API_KEY
npm run dev
```

## 模型配置

走 OpenAI 兼容接口，改环境变量即可切换（见 `.env.example`）：

| 变量 | 默认值 |
|---|---|
| `LLM_BASE_URL` | `https://open.bigmodel.cn/api/paas/v4`（智谱） |
| `LLM_API_KEY` | 必填 |
| `LLM_MODEL` | `glm-4-flash` |

## 部署到 Vercel

在 Vercel 导入本仓库，在 Project Settings → Environment Variables 填上面三个变量，之后每次 push 到 main 自动部署。

## 目录

- `src/lib/llm.ts` 模型调用（普通 / JSON / 流式）
- `src/lib/prompts.ts` 四个提示词：采访、整理、匹配、撰写
- `src/lib/validate.ts` 防编造校验
- `src/lib/storage.ts` localStorage 持久化
