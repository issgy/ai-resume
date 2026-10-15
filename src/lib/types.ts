export type Fact = {
  id: string;
  text: string;
  /** 用户原话，用于溯源 */
  source: string;
};

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

export type Requirement = {
  text: string;
  type: "must" | "nice";
  factIds: string[];
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
};
