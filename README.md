# 有据简历（简版）

> 粘贴 JD，生成每句都有出处的简历

一次录入真实经历，粘贴 JD 定向生成简历。每条亮点都能追溯到用户原话，并附面试追问；找不到依据的内容不写进简历。

## 功能流程

1. `/collect` 对话录入：模型追问细节和数字，"整理入库"时拆成原子事实，每条事实的 `source` 必须逐字出现在用户发言里，否则丢弃
2. `/vault` 履历库：编辑、删除、手动补充事实；导出/导入 JSON 备份
3. `/match` 粘贴 JD：生成"JD 要求 ↔ 事实"匹配表，没有依据的要求标为缺口
4. `/resume` 定向简历：亮点必须引用事实，且亮点中的数字必须出现在所引事实中，否则剔除并说明原因；面试参考回答中的数字和英文专有名词也必须出自所引事实，否则替换为「素材不足」提示；前端直接生成 A4 PDF（微信/支付宝内置浏览器中改为长图保存）

首页「一键体验示例」会填入一份示例履历和 JD，直接跳到匹配页。

数据只存在浏览器 localStorage，没有登录和数据库。

## 本地运行

```bash
npm install
cp .env.example .env.local   # 填入 LLM_API_KEY
npm run dev
```

## 模型配置

走 OpenAI 兼容接口，改环境变量即可切换（见 `.env.example`）。分两档：

| 变量 | 用途 | 默认值 |
|---|---|---|
| `LLM_BASE_URL` | 默认档：录入对话（要求快） | `https://open.bigmodel.cn/api/paas/v4`（智谱） |
| `LLM_API_KEY` | | 必填 |
| `LLM_MODEL` | | `glm-4-flash` |
| `LLM_STRONG_BASE_URL` | 强模型档：整理、匹配、撰写（要求准） | 同 `LLM_BASE_URL` |
| `LLM_STRONG_API_KEY` | | 可选，不填则三步也用默认档 |
| `LLM_STRONG_MODEL` | | 同 `LLM_MODEL` |

强模型档示例：通义千问 `https://dashscope.aliyuncs.com/compatible-mode/v1` + `qwen-plus`，或 DeepSeek `https://api.deepseek.com` + `deepseek-chat`。

## 部署到 Vercel

在 Vercel 导入本仓库，在 Project Settings → Environment Variables 填上面的变量（至少 `LLM_API_KEY`），之后每次 push 到 main 自动部署。`vercel.json` 把函数区域设在香港（hkg1），离国内模型接口更近。

## 目录

- `src/lib/llm.ts` 模型调用（普通 / JSON / 流式）
- `src/lib/prompts.ts` 四个提示词：采访、整理、匹配、撰写
- `src/lib/validate.ts` 防编造校验
- `src/lib/storage.ts` localStorage 持久化
