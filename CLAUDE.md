# 有据简历 · AI 协作规则

本文件同时供 Claude Code（CLAUDE.md）和 Codex（AGENTS.md）读取，两者内容保持一致。

## 项目
- Next.js 15 + React 19 + TypeScript + Tailwind 4，部署在 Vercel（main 分支 = 线上）
- 数据只存浏览器 localStorage，无登录、无数据库
- LLM 走 OpenAI 兼容接口，配置见 README.md 与 `.env.example`
- 产品需求：`docs/PRD.md`；验收差距与待办：`docs/GAPS.md`

## 常用命令
- 开发：`npm run dev`
- 检查（每次提交前必须通过）：`npx tsc --noEmit && npm run lint && npm run build`

## 工作流程
- **禁止直接 push 到 main**。每个任务从最新 main 新建分支 `fix/xxx` 或 `feat/xxx`
- 一个 PR 只做 `docs/GAPS.md` 待办清单中的一项，PR 标题注明编号（如 `fix: GAPS#1 可信回答失败时剔除亮点`）
- 完成后用 `gh pr create` 开 PR，描述里逐条对照该项的「验收标准」说明如何满足、如何验证
- 收到 PR 中的 Codex 审查意见后在同一分支修复，直到没有阻塞问题
- 完成后在 `docs/GAPS.md` 对应条目标注 `✅ 已修复（PR #N）`
- 涉及数据结构改动（`src/lib/types.ts`、localStorage 格式）时，先在 PR 描述写方案，并保证旧数据可继续读取

## 产品红线（来自 PRD 第 6 节信任机制）
- 简历内容只能来自用户输入，每条亮点必须可溯源到用户原话，不得生成用户未提供的经历、技能、数字
- 亮点必须通过溯源核验才写进简历；面试追问答不上来（参考回答不可信）时不代答，标「需要你补充」并引导到履历库补充，亮点保留（产品决策，取代原「答不上来的亮点不交付」）
- 不要为了让校验通过而放宽 `src/lib/validate.ts` 的校验规则
- 不要提交 `.env.local` 或任何 API Key
