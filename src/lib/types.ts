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

/** JD 要求类别（02 Requirement.category） */
export type RequirementCategory = "hard_gate" | "core_responsibility" | "professional_ability" | "soft_ability" | "bonus";
/** 要求级匹配状态（02 Match.status）：actual_gap 只用于程序能确定不满足的情况；材料没写是 unknown / needs_evidence */
export type MatchStatus = "direct_support" | "transferable_support" | "expression_gap" | "needs_evidence" | "actual_gap" | "unknown";
export type HardGateResult = "met" | "not_met" | "unknown" | "not_applicable";

/** 一条支持证据（多对多边的一个子项）：可以引用多条事实，也可以引用能力推断 */
export type Evidence = {
  factIds: string[];
  abilityIds: string[];
  /** direct：行为直接支持；transferable：情境不同但方法可迁移 */
  relation: "direct" | "transferable";
  rationale: string;
};

/** 从行为推断的能力（02 AbilityEvidence）：推断与事实分开存；未经用户确认不作为事实导出（R09） */
export type AbilityEvidence = {
  id: string;
  ability: string;
  factIds: string[];
  relation: "direct" | "transferable";
  /** 为什么这些行为能支持这项能力 */
  reasoning: string;
  /** 推断的边界：不能据此推出什么 */
  boundary: string;
  missingDetails: string[];
  /** 读取时按用户的确认记录合并；没有记录为 pending */
  confirmation?: "pending" | "confirmed" | "rejected";
};

export type Requirement = {
  /** 稳定 id（R1、R2…），旧数据没有 */
  id?: string;
  /** JD 原文片段 */
  jdQuote?: string;
  category?: RequirementCategory;
  /** 要求里的逻辑：至少 / 优先 / 任一 / 全部 / 不要求 等 */
  logic?: string;
  ambiguity?: string;
  status?: MatchStatus;
  evidence?: Evidence[];
  hardGate?: HardGateResult;
  /** 模型最初的判断（状态与缺失点）：每次按当前证据重新推导时作参考 */
  modelStatus?: MatchStatus;
  modelMissing?: string[];
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
  /** 回答暂不可用是因为来源已修改或核验请求失败（可重试），而不是资料不足 */
  retryable?: boolean;
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
  /** 用户改过措辞（02 R01：改写的表述单独存放，不覆盖履历原文） */
  edited?: boolean;
  /** 用户第一次改写前、生成时的句子，用于「恢复生成的版本」 */
  generatedText?: string;
  assertionChecks?: AssertionCheck[];
  /** 面试追问生成失败（不影响亮点导出，可重试） */
  qaFailed?: boolean;
  /** 这句对应的 JD 要求 id */
  requirementIds?: string[];
  /**
   * 选材去向（02 ResumeBullet.selection_status）：expanded / condensed 写入简历；optional 低相关、默认不放进简历；
   * hidden_by_user 用户从简历中移出。都可恢复，不删除资产。旧数据没有该字段，按写入简历处理
   */
  selection?: Selection;
};

export type Selection = "expanded" | "condensed" | "optional" | "hidden_by_user";

/** 每段经历在本份简历中的去向与原因 */
export type Disposition = { experienceId: string; level: "expanded" | "condensed" | "optional"; reason: string };
/** 本次没有写进句子的事实及原因 */
export type UnusedFact = { experienceId: string; factId: string; reason: string };

export type DroppedHighlight = {
  text: string;
  reason: string;
  /** 所属经历与所引事实；旧数据没有这两个字段 */
  experienceId?: string;
  factIds?: string[];
};

export type MatchResult = {
  jd: string;
  requirements: Requirement[];
  /** 2：多对多匹配格式（含 status/evidence/abilities）；旧数据没有 */
  version?: 2;
  abilities?: AbilityEvidence[];
  /** 每段经历关联到了哪些要求，没关联的写明原因（防止静默漏失） */
  experienceCoverage?: { experienceId: string; requirementIds: string[]; reason: string }[];
  /** 最多五个最影响结果的补充问题 */
  questions?: string[];
  /** 分析时各事实的原话快照：事实之后被修改，引用它的证据失效待重新分析 */
  factSources?: Record<string, string>;
};

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
  /** 生成时的能力推断（含确认状态） */
  abilities?: AbilityEvidence[];
  /** 生成时的完整匹配结果：局部重试时按当前履历和确认记录重新推导撰写用匹配表 */
  match?: MatchResult;
  /** 每段经历的篇幅去向与原因；旧数据没有 */
  dispositions?: Disposition[];
  /** 没有写进句子的事实及原因；旧数据没有 */
  unused?: UnusedFact[];
};
