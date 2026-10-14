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

/** 把简历节点渲染成长图，并算出不会切断条目的分页位置（单位：canvas 像素） */
export async function renderResume(el: HTMLElement): Promise<RenderedResume> {
  const { default: html2canvas } = await import("html2canvas-pro");
  const scale = 2;
  const pageHeight = Math.floor(PAGE_WIDTH_PX * A4_RATIO);
  let blockBottoms: number[] = [];

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
      // 记录每个条目的底部位置，分页时只在条目之间断开
      const top = clone.getBoundingClientRect().top;
      blockBottoms = Array.from(clone.querySelectorAll("header, h2, li, section > div, p"))
        .filter((n) => !n.closest(".no-print"))
        .map((n) => n.getBoundingClientRect().bottom - top)
        .sort((a, b) => a - b);
    },
  });

  const breaks: number[] = [];
  const total = canvas.height / scale;
  let start = 0;
  // 首页自带上边距；续页在 toPdf 里补上边距，所以可用高度要再减掉一个边距
  const available = () => pageHeight - PAGE_PADDING_PX / 2 - (breaks.length > 0 ? PAGE_PADDING_PX : 0);
  while (total - start > available() + PAGE_PADDING_PX / 2) {
    const limit = start + available();
    const candidates = blockBottoms.filter((b) => b > start + pageHeight / 3 && b <= limit);
    const cut = candidates.length ? candidates[candidates.length - 1] + 8 : limit;
    breaks.push(Math.round(cut * scale));
    start = cut;
  }
  return { canvas, breaks };
}

/** 按分页位置把长图切成 A4 页，生成 PDF 文件 */
export async function toPdf({ canvas, breaks }: RenderedResume, fileName: string): Promise<File> {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ unit: "mm", format: "a4", compress: true });
  const pageW = 210;
  const pxPerMm = canvas.width / pageW;
  const bounds = [0, ...breaks, canvas.height];

  for (let i = 0; i < bounds.length - 1; i++) {
    const sliceH = bounds[i + 1] - bounds[i];
    const page = document.createElement("canvas");
    page.width = canvas.width;
    page.height = sliceH;
    const ctx = page.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, page.width, page.height);
    ctx.drawImage(canvas, 0, bounds[i], canvas.width, sliceH, 0, 0, canvas.width, sliceH);
    if (i > 0) pdf.addPage();
    // 续页顶部留出与首页相同的边距
    const topMm = i === 0 ? 0 : PAGE_PADDING_PX / (PAGE_WIDTH_PX / pageW);
    pdf.addImage(page.toDataURL("image/jpeg", 0.92), "JPEG", 0, topMm, pageW, sliceH / pxPerMm);
  }
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
