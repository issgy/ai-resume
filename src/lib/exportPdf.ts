/**
 * 前端直接把简历正文渲染成 PDF，不依赖 window.print()（手机浏览器和微信/支付宝内置浏览器基本不支持打印）。
 * html2canvas-pro 支持 Tailwind v4 的 oklch 颜色；两个库都在点击导出时才动态加载。
 */

/** A4 宽度（96dpi 下 210mm ≈ 794px），导出时按这个宽度排版，手机上也能得到正常的版式 */
const PAGE_WIDTH_PX = 794;
const PAGE_PADDING_PX = 56;
const A4_RATIO = 297 / 210;

/** 微信、支付宝、QQ、钉钉等内置浏览器会拦截文件下载 */
export function isInAppBrowser() {
  return /MicroMessenger|AlipayClient|QQ\/|DingTalk|Weibo/i.test(navigator.userAgent);
}

export type RenderedResume = { canvas: HTMLCanvasElement; breaks: number[] };

/** 一行文字在长图里的位置；block 是这行所属的条目，title 表示经历标题等必须和下文放在同一页的行 */
type Line = { t: number; b: number; block: Element | null; title: boolean };
/** 两行之间可以断页的位置 */
export type Gap = { y: number; kind: "block" | "line" };

/** 必须和下面的内容放在同一页的标题（经历标题行、「工作经历」等小标题、页头） */
const TITLE_SELECTOR = "section > div:first-child, h2, h3";
const BLOCK_SELECTOR = "li, p, header, h2, h3, section > div";

/** 收集正文里每一行文字的位置（相对 root 顶部），用来找不会切断文字的断页位置 */
function collectLines(root: HTMLElement): Line[] {
  const doc = root.ownerDocument;
  const top = root.getBoundingClientRect().top;
  const lines: Line[] = [];
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || !node.textContent?.trim() || el.closest(".no-print")) continue;
    const range = doc.createRange();
    range.selectNodeContents(node);
    const block = el.closest(BLOCK_SELECTOR);
    const title = !!el.closest(TITLE_SELECTOR);
    for (const r of Array.from(range.getClientRects())) {
      if (r.height > 0) lines.push({ t: r.top - top, b: r.bottom - top, block, title });
    }
  }
  return lines.sort((a, b) => a.t - b.t);
}

/**
 * 行与行之间的空隙：断页只能落在空隙正中，绝不切进文字（04「分页无截断」）。
 * 同一行的多个片段合并；标题行之后的空隙不能断（标题不单独留在页底）。
 */
export function gapsBetween(lines: Line[]): Gap[] {
  const rows: Line[] = [];
  for (const l of lines) {
    const last = rows[rows.length - 1];
    if (last && l.t < last.b - 1) {
      last.b = Math.max(last.b, l.b);
      last.title = last.title || l.title;
    } else rows.push({ ...l });
  }
  const gaps: Gap[] = [];
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = rows[i], b = rows[i + 1];
    if (a.title || b.t <= a.b) continue;
    gaps.push({ y: (a.b + b.t) / 2, kind: a.block && a.block === b.block ? "line" : "block" });
  }
  return gaps;
}

/**
 * 选断页位置：优先在条目之间断（页面至少用到一半）；放不下时退到同一条目的行间；
 * 都没有才在页底硬切（只会出现在单行比整页还高的极端情况）。
 */
export function pageBreaks(total: number, pageHeight: number, padding: number, gaps: Gap[]): number[] {
  const breaks: number[] = [];
  let start = 0;
  // 首页自带上边距；续页在 toPdf 里补上边距，所以可用高度要再减掉一个边距
  const available = () => pageHeight - padding / 2 - (breaks.length > 0 ? padding : 0);
  while (total - start > available() + padding / 2) {
    const limit = start + available();
    const within = (from: number, kind?: Gap["kind"]) => gaps.filter((g) => g.y > from && g.y <= limit && (!kind || g.kind === kind));
    const pick =
      within(start + pageHeight / 2, "block").pop() ??
      within(start + pageHeight / 3).pop() ??
      within(start).pop();
    const cut = pick ? pick.y : limit;
    breaks.push(cut);
    start = cut;
  }
  return breaks;
}

/** 把简历节点渲染成长图，并算出不会切断文字的分页位置（单位：canvas 像素） */
export async function renderResume(el: HTMLElement): Promise<RenderedResume> {
  const { default: html2canvas } = await import("html2canvas-pro");
  const scale = 2;
  const pageHeight = Math.floor(PAGE_WIDTH_PX * A4_RATIO);
  let gaps: Gap[] = [];

  const canvas = await html2canvas(el, {
    scale,
    backgroundColor: "#ffffff",
    windowWidth: 1200,
    // 不导出屏幕专用元素（提示、标签、展开的来源与追问）
    ignoreElements: (node) => node.classList?.contains("no-print"),
    onclone: (_doc, clone) => {
      Object.assign(clone.style, {
        width: `${PAGE_WIDTH_PX}px`,
        maxWidth: "none",
        margin: "0",
        padding: `${PAGE_PADDING_PX}px`,
        border: "0",
        borderRadius: "0",
        boxShadow: "none",
      });
      clone.querySelectorAll("details").forEach((d) => d.removeAttribute("open"));
      gaps = gapsBetween(collectLines(clone));
    },
  });

  const breaks = pageBreaks(canvas.height / scale, pageHeight, PAGE_PADDING_PX, gaps).map((b) => Math.round(b * scale));
  return { canvas, breaks };
}

/** 按分页位置把长图切成 A4 页（续页顶部补上与首页相同的边距），PDF 与分页预览共用 */
export function slicePages({ canvas, breaks }: RenderedResume): HTMLCanvasElement[] {
  const pxPerPagePx = canvas.width / PAGE_WIDTH_PX;
  const pageH = Math.round(PAGE_WIDTH_PX * A4_RATIO * pxPerPagePx);
  const topPad = Math.round(PAGE_PADDING_PX * pxPerPagePx);
  const bounds = [0, ...breaks, canvas.height];
  const pages: HTMLCanvasElement[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const sliceH = bounds[i + 1] - bounds[i];
    const offset = i === 0 ? 0 : topPad;
    const page = document.createElement("canvas");
    page.width = canvas.width;
    page.height = Math.max(pageH, sliceH + offset);
    const ctx = page.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, page.width, page.height);
    ctx.drawImage(canvas, 0, bounds[i], canvas.width, sliceH, 0, offset, canvas.width, sliceH);
    pages.push(page);
  }
  return pages;
}

/** 生成 PDF 文件 */
export async function toPdf(rendered: RenderedResume, fileName: string): Promise<File> {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ unit: "mm", format: "a4", compress: true });
  const pageW = 210;
  slicePages(rendered).forEach((page, i) => {
    if (i > 0) pdf.addPage();
    pdf.addImage(page.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, pageW, (page.height * pageW) / page.width);
  });
  return new File([pdf.output("blob")], fileName, { type: "application/pdf" });
}

/** 保存文件：手机上优先走系统分享（可存到「文件」或发给微信好友），否则直接下载 */
export async function saveFile(file: File) {
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (mobile && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      return;
    } catch (e) {
      if ((e as Error).name === "AbortError") return; // 用户取消了分享
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
