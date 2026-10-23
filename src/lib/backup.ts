/**
 * 备份文件校验（交接包 F12）：导入前检查结构，剔除缺字段的条目并说明，避免损坏或无关文件让页面报错或静默覆盖资料。
 * 只做结构校验，不改写任何文字内容。
 */
import { KEYS } from "@/lib/storage";
import type { Education, Experience, Fact, Profile } from "@/lib/types";

export const BACKUP_APP = "ai-resume";
export const BACKUP_VERSION = 1;
/** 备份文件上限：正常备份远小于此，超过多半不是本站的备份 */
export const BACKUP_MAX_BYTES = 5 * 1024 * 1024;

export type BackupSummary = { experiences: number; facts: number; education: number; hasResume: boolean; hasMatch: boolean };
export type ParsedBackup = { data: Partial<Record<(typeof KEYS)[keyof typeof KEYS], unknown>>; summary: BackupSummary; warnings: string[] };

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown) => (typeof x === "string" ? x : "");
const ORIGINS = ["chat", "imported", "manual", "edited"] as const;

/** 不是列表时返回 null：这一项不导入、保留当前资料（不能当成空列表把当前资料清空） */
function sanitizeExperiences(raw: unknown, warnings: string[]): Experience[] | null {
  if (!Array.isArray(raw)) {
    warnings.push("经历数据结构不对，没有导入（当前履历库保留）");
    return null;
  }
  let badExp = 0;
  let badFact = 0;
  let dupFact = 0;
  const seenExp = new Set<string>();
  const seenFact = new Set<string>();
  const out: Experience[] = [];
  for (const x of raw) {
    if (!isObj(x) || !str(x.id) || seenExp.has(str(x.id))) {
      badExp++;
      continue;
    }
    seenExp.add(str(x.id));
    const facts: Fact[] = [];
    for (const f of Array.isArray(x.facts) ? x.facts : []) {
      const text = isObj(f) ? str(f.text) || str(f.source) : "";
      // 文字被清空但还保留着修改前原话的事实也要保留（R01：原始材料不能丢）
      if (!isObj(f) || !str(f.id) || (!text.trim() && !str(f.originalSource).trim())) {
        badFact++;
        continue;
      }
      // 事实 id 是简历句、匹配证据引用来源的依据，重复会让来源对错，只保留第一条
      if (seenFact.has(str(f.id))) {
        dupFact++;
        continue;
      }
      seenFact.add(str(f.id));
      const origin = ORIGINS.find((o) => o === f.origin);
      facts.push({ id: str(f.id), text, source: str(f.source) || text, ...(origin ? { origin } : {}), ...(str(f.originalSource) ? { originalSource: str(f.originalSource) } : {}) });
    }
    out.push({ id: str(x.id), company: str(x.company), title: str(x.title), start: str(x.start), end: str(x.end), facts });
  }
  if (badExp) warnings.push(`${badExp} 段经历缺少编号或编号重复，已跳过`);
  if (badFact) warnings.push(`${badFact} 条事实缺少编号或内容，已跳过`);
  if (dupFact) warnings.push(`${dupFact} 条事实编号重复，只保留了第一条`);
  return out;
}

const optStr = (x: unknown) => x === undefined || typeof x === "string";
const optArr = (x: unknown) => x === undefined || Array.isArray(x);
const optStrArr = (x: unknown) => x === undefined || (Array.isArray(x) && x.every((v) => typeof v === "string"));

/**
 * 简历：只校验页面实际读取的结构；结构不对就不导入（重新生成即可），不让页面报错。
 * 引用的事实不在履历库里不算结构错误——页面的 markStale 会把这些句子标为「来源已修改，待重验」、不会导出，
 * 其他句子、改过的措辞、选材和顺序照常恢复。
 */
function sanitizeResume(x: unknown): Record<string, unknown> | null {
  if (!isObj(x) || typeof x.jd !== "string" || !Array.isArray(x.highlights)) return null;
  const okHighlights = x.highlights.every(
    (h) =>
      isObj(h) &&
      typeof h.text === "string" &&
      typeof h.experienceId === "string" &&
      optStrArr(h.factIds) && Array.isArray(h.factIds) &&
      Array.isArray(h.questions) &&
      h.questions.every((q) => isObj(q) && typeof q.q === "string") &&
      optStrArr(h.requirementIds) &&
      (h.sources === undefined || isObj(h.sources)),
  );
  if (!okHighlights) return null;
  if (!optArr(x.dropped) || !optStrArr(x.failedExperienceIds) || !optArr(x.dispositions) || !optArr(x.unused) || !optStrArr(x.order) || !optArr(x.requirements) || !optArr(x.abilities)) return null;
  // 页面会逐个读取这些列表的元素
  const each = (arr: unknown, check: (v: Record<string, unknown>) => boolean) => arr === undefined || (arr as unknown[]).every((v) => isObj(v) && check(v));
  const okLists =
    each(x.dropped, (d) => typeof d.text === "string" && optStr(d.reason) && optStrArr(d.factIds)) &&
    each(x.dispositions, (d) => typeof d.experienceId === "string" && typeof d.level === "string" && optStr(d.reason)) &&
    each(x.unused, (u) => typeof u.experienceId === "string" && typeof u.factId === "string" && optStr(u.reason)) &&
    each(x.requirements, (r) => typeof r.text === "string") &&
    each(x.abilities, (a) => optStrArr(a.factIds));
  if (!okLists) return null;
  if (x.match !== undefined && x.match !== null && !validMatch(x.match)) return null;
  // 旧版本可能没有 dropped，补成空列表
  return { ...x, dropped: x.dropped ?? [] };
}
function validMatch(x: unknown): boolean {
  return (
    isObj(x) &&
    typeof x.jd === "string" &&
    Array.isArray(x.requirements) &&
    x.requirements.every((r) => isObj(r) && typeof r.text === "string" && optArr(r.evidence) && optStrArr(r.factIds)) &&
    optArr(x.abilities) &&
    (x.abilities === undefined || (x.abilities as unknown[]).every((a) => isObj(a) && optStrArr(a.factIds)))
  );
}

/** 解析并校验备份；不是本站备份、或没有任何可用内容时抛出可读的错误 */
export function parseBackup(json: string): ParsedBackup {
  if (json.length > BACKUP_MAX_BYTES) throw new Error("文件太大，不像是本站导出的备份");
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("文件不是有效的 JSON，可能已损坏");
  }
  if (!isObj(raw)) throw new Error("文件结构不对，不是本站导出的备份");
  if (raw.app !== undefined && raw.app !== BACKUP_APP) throw new Error("这是其他应用的备份文件");
  if (typeof raw.version === "number" && raw.version > BACKUP_VERSION) throw new Error("备份来自更新版本的网站，请刷新页面后再导入");
  if (!Object.values(KEYS).some((k) => k in raw)) throw new Error("文件里没有履历库数据，不是本站导出的备份");

  const warnings: string[] = [];
  const data: ParsedBackup["data"] = {};
  // 导出时没有数据的项是 null：不导入，也不算错误
  const experiences = raw[KEYS.experiences] != null ? sanitizeExperiences(raw[KEYS.experiences], warnings) : null;
  if (experiences) data[KEYS.experiences] = experiences;
  const factIds = new Set((experiences ?? []).flatMap((e) => e.facts.map((f) => f.id)));

  if (raw[KEYS.education] != null) {
    if (!Array.isArray(raw[KEYS.education])) warnings.push("教育背景结构不对，没有导入（当前教育背景保留）");
    else {
      // 备份恢复只做结构校验：学校还没填的未完成记录也原样保留
      const list = raw[KEYS.education] as unknown[];
      const seen = new Set<string>();
      const education: Education[] = list.flatMap((e) => {
        if (!isObj(e) || !str(e.id) || seen.has(str(e.id))) return [];
        seen.add(str(e.id));
        const origin = e.origin === "imported" || e.origin === "manual" || e.origin === "edited" ? e.origin : undefined;
        return [{ id: str(e.id), school: str(e.school), degree: str(e.degree), major: str(e.major), start: str(e.start), end: str(e.end), source: str(e.source), ...(origin ? { origin } : {}) }];
      });
      if (list.length > education.length) warnings.push(`${list.length - education.length} 条教育背景缺少编号或编号重复，已跳过`);
      data[KEYS.education] = education;
    }
  }
  if (raw[KEYS.profile] != null) {
    const p = raw[KEYS.profile];
    if (isObj(p)) data[KEYS.profile] = { name: str(p.name), phone: str(p.phone), email: str(p.email), school: str(p.school), birthday: str(p.birthday) } satisfies Profile;
    else warnings.push("个人信息结构不对，已忽略");
  }
  if (raw[KEYS.chat] != null) {
    const chat = raw[KEYS.chat];
    if (Array.isArray(chat) && chat.every((m) => isObj(m) && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")) data[KEYS.chat] = chat;
    else warnings.push("对话记录结构不对，已忽略");
  }
  if (raw[KEYS.abilityDecisions] != null) {
    if (isObj(raw[KEYS.abilityDecisions])) data[KEYS.abilityDecisions] = raw[KEYS.abilityDecisions];
    else warnings.push("能力确认记录结构不对，已忽略");
  }
  if (typeof raw[KEYS.jdDraft] === "string") data[KEYS.jdDraft] = raw[KEYS.jdDraft];
  if (raw[KEYS.match] != null) {
    if (validMatch(raw[KEYS.match])) data[KEYS.match] = raw[KEYS.match];
    else warnings.push("JD 匹配结果结构不对，没有导入（重新分析即可）");
  }
  if (raw[KEYS.resume] != null) {
    const resume = sanitizeResume(raw[KEYS.resume]);
    if (resume) data[KEYS.resume] = resume;
    else warnings.push("简历结果结构不对，没有导入（重新生成即可）");
  }

  const summary: BackupSummary = {
    experiences: experiences?.length ?? 0,
    facts: factIds.size,
    education: Array.isArray(data[KEYS.education]) ? (data[KEYS.education] as unknown[]).length : 0,
    hasResume: KEYS.resume in data,
    hasMatch: KEYS.match in data,
  };
  if (Object.keys(data).length === 0) throw new Error("备份里没有可以导入的内容");
  return { data, summary, warnings };
}
