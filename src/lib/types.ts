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

export type QA = { q: string; a: string };

export type Highlight = {
  experienceId: string;
  text: string;
  factIds: string[];
  questions: QA[];
};

export type DroppedHighlight = { text: string; reason: string };

export type MatchResult = { jd: string; requirements: Requirement[] };

export type ResumeResult = {
  jd: string;
  highlights: Highlight[];
  dropped: DroppedHighlight[];
};
