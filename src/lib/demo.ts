import { KEYS, uid } from "./storage";
import type { Experience } from "./types";

/** 「一键体验示例」用的履历和 JD，方便评委 30 秒看到完整效果 */
const DEMO_EXPERIENCES: Omit<Experience, "id">[] = [
  {
    company: "字节跳动",
    title: "前端工程师",
    start: "2021-03",
    end: "2023-06",
    facts: [
      { id: "", text: "负责抖音电商商家后台前端开发，技术栈为 React 和 TypeScript", source: "负责抖音电商商家后台，主要用 React 和 TypeScript" },
      { id: "", text: "用 React 重构商品管理页面，通过路由懒加载和长列表虚拟滚动，首屏时间从 3 秒降到 1.2 秒", source: "我用 React 重构了商品管理页面，做了路由懒加载和长列表虚拟滚动，首屏时间从 3 秒降到 1.2 秒" },
      { id: "", text: "带教 3 名实习生，每周进行代码评审", source: "带了 3 个实习生，每周给他们做代码评审" },
      { id: "", text: "搭建前端监控平台，线上报错从每天 200 多条降到 30 条以内", source: "搭了一套前端监控，线上报错从每天 200 多条降到 30 条以内" },
    ],
  },
  {
    company: "杭州某零食电商",
    title: "运营专员",
    start: "2019-07",
    end: "2021-02",
    facts: [
      { id: "", text: "负责天猫旗舰店日常运营和大促活动", source: "负责天猫旗舰店的日常运营和大促活动" },
      { id: "", text: "策划 2020 年双十一活动，店铺当天 GMV 860 万，同比增长 35%", source: "策划了 2020 年双十一活动，店铺当天 GMV 做到 860 万，比前一年增长 35%" },
      { id: "", text: "用生意参谋分析数据并优化主图和详情页，店铺转化率从 2.1% 提升到 3.4%", source: "用生意参谋看数据，调整主图和详情页，把店铺转化率从 2.1% 提到了 3.4%" },
    ],
  },
];

const DEMO_JD = `岗位：高级前端工程师（电商方向）
职责：
1. 负责电商平台商家后台的前端架构设计与开发；
2. 持续优化页面性能与稳定性，提升商家使用体验；
3. 与产品、运营协作，支持大促活动需求快速上线；
4. 参与代码评审，指导初级工程师成长。
要求：
1. 3 年以上前端开发经验，精通 React 和 TypeScript；
2. 有大型项目性能优化经验，熟悉前端监控体系；
3. 有电商业务经验者优先，理解运营数据指标者优先；
4. 有团队带人经验者优先；熟悉 Node.js 者优先。`;

export function hasUserData() {
  try {
    const raw = localStorage.getItem(KEYS.experiences);
    return !!raw && (JSON.parse(raw) as unknown[]).length > 0;
  } catch {
    return false;
  }
}

/** 写入示例数据，并清掉旧的匹配和简历结果，避免和示例混在一起 */
export function loadDemo() {
  const experiences: Experience[] = DEMO_EXPERIENCES.map((e) => ({
    ...e,
    id: uid(),
    facts: e.facts.map((f) => ({ ...f, id: uid() })),
  }));
  localStorage.setItem(KEYS.experiences, JSON.stringify(experiences));
  localStorage.setItem(KEYS.jdDraft, JSON.stringify(DEMO_JD));
  localStorage.removeItem(KEYS.match);
  localStorage.removeItem(KEYS.resume);
}
