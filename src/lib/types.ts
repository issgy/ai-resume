export type Fact = {
  id: string;
  text: string;
  /** 用户原话，用于溯源；在履历库手动修改后即为修改后的文字 */
  source: string;
  /** 来源类型：对话录入 / 简历导入 / 手动补充 / 手动修改；旧数据没有该字段，按对话录入处理 */
  origin?: FactOrigin;
  /** 手动修改前的原话（只在第一次修改时记录） */
  originalSource?: string;
};

/** imported：从粘贴的简历文本导入，source 是粘贴原文中的逐字连续片段 */
export type FactOrigin = "chat" | "imported" | "manual" | "edited";

export type Experience = {
  id: string;
  company: string;
  title: string;
  start: string;
  end: string;
  facts: Fact[];
};

export type Profile = {
  name: string;
  phone: string;
  email: string;
  school: string;
  birthday: string;
};

export type ChatMessage = { role: "user" | "assistant"; content: string };

/** full：所引事实完整覆盖；partial：只覆盖一部分；none：缺口 */
export type Coverage = "full" | "partial" | "none";

export type Requirement = {
  text: string;
  type: "must" | "nice";
  factIds: string[];
  /** 旧数据没有该字段，读取时按 factIds 是否为空推断，再经过 checkRequirements 同样的校验 */
  coverage?: Coverage;
  /** 要求中没有被所引事实覆盖的具体点；旧数据没有该字段 */
  missing?: string[];
};

export type QA = {
  q: string;
  a: string;
  /** 参考回答依据的事实 id */
  factIds?: string[];
  /** 参考回答没通过校验、已替换为补充提示 */
  insufficient?: boolean;
};

export type Highlight = {
  experienceId: string;
  text: string;
  factIds: string[];
  questions: QA[];
  /** 生成并核验时所引事实的原话快照（事实 id → 原话）；之后事实被改或删，亮点即失效。旧数据没有该字段 */
  sources?: Record<string, string>;
};

export type DroppedHighlight = {
  text: string;
  reason: string;
  /** 所属经历与所引事实；旧数据没有这两个字段 */
  experienceId?: string;
  factIds?: string[];
};

export type MatchResult = { jd: string; requirements: Requirement[] };

export type ResumeResult = {
  jd: string;
  highlights: Highlight[];
  dropped: DroppedHighlight[];
  /**
   * 经过内容核验流程生成（GAPS#2 之后）：可导出的条目只有 highlights 中逐条核验过的亮点，
   * 简历页不会把未核验的履历事实写进正文。旧简历没有该字段，只能查看、不能导出
   */
  provenanceChecked?: boolean;
  /** 撰写请求失败或没返回亮点的经历 id；旧数据没有该字段 */
  failedExperienceIds?: string[];
};
