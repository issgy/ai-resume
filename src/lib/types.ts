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

/** 教育背景：用于判断学历、专业类要求；导入时各字段都是原文中的逐字片段，source 是原文所在行 */
export type Education = {
  id: string;
  school: string;
  /** 学历，如「本科」「全日制硕士」 */
  degree: string;
  major: string;
  start: string;
  end: string;
  /** 原文（导入时为原文所在行；手动填写时为空） */
  source: string;
  origin?: "imported" | "manual" | "edited";
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
  /** 学历、专业类要求由程序按教育背景判断，依据是这些教育背景的 id（此时 factIds 为空） */
  educationIds?: string[];
  /** 不限领域的工作年限要求由程序按任职经历起止时间计算，依据是这些经历的 id（此时 factIds 为空） */
  experienceIds?: string[];
};

export type QA = {
  q: string;
  a: string;
  /** 参考回答依据的事实 id */
  factIds?: string[];
  /** 参考回答没通过校验、已替换为补充提示（与 preparationStatus = needs_details 同义，旧数据只有该字段） */
  insufficient?: boolean;
  /** 面试准备状态：ready 参考回答只用了来源事实；needs_details 来源不足，需要用户补充（不影响亮点和事实） */
  preparationStatus?: "ready" | "needs_details";
  /** 回答这道题还缺的具体细节 */
  missingDetails?: string[];
  /** 参考回答所依据事实的原话快照；之后这些事实被改或删，回答即隐藏待重生成 */
  sources?: Record<string, string>;
};

/**
 * 简历句的导出状态（02 ResumeBullet.export_status）：
 * ready 可导出；pending 待处理（模型调用失败、来源已修改待重验），不导出、可重试；blocked 来源冲突或引用的不是候选人行为，不导出
 */
export type ExportStatus = "ready" | "pending" | "blocked";
/** 02 / 03-M5 issue_type；stale 表示来源事实在生成后被修改或删除 */
export type IssueType = "unsupported_assertion" | "source_conflict" | "pending_inference" | "technical_error" | "stale";

/** 句中一个断言的核验结果（行动、数字、范围、角色、结果、因果、工具） */
export type AssertionCheck = { claim: string; type: string; supported: boolean; conflict?: boolean; reason?: string };

export type Highlight = {
  experienceId: string;
  text: string;
  factIds: string[];
  questions: QA[];
  /** 生成并核验时所引事实的原话快照（事实 id → 原话）；之后事实被改或删，亮点即失效。旧数据没有该字段 */
  sources?: Record<string, string>;
  /** 旧数据没有该字段：经过核验流程（provenanceChecked）的旧亮点按 ready 处理 */
  exportStatus?: ExportStatus;
  issueType?: IssueType | null;
  /** 给用户看的处理说明（为什么待处理、删去了哪些说法、是否已退回原话） */
  note?: string;
  /** 核验时被缩小或退回原话前的候选句 */
  originalText?: string;
  assertionChecks?: AssertionCheck[];
  /** 面试追问生成失败（不影响亮点导出，可重试） */
  qaFailed?: boolean;
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
  /** 生成时用到的匹配表（局部重试同一段经历时复用）；旧数据没有该字段 */
  requirements?: Requirement[];
};
