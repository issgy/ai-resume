import Link from "next/link";

export default function Home() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">可辩护的 JD 匹配器</h1>
      <p className="text-slate-600">
        一次录入真实经历，粘贴 JD 自动定向重写。简历上的每条亮点都能追溯到你说过的原话，并附带面试追问。
      </p>
      <ol className="list-decimal space-y-1 pl-5 text-slate-700">
        <li>对话式录入一段经历，系统追问细节和数字</li>
        <li>在履历库里检查、修改每条事实</li>
        <li>粘贴目标岗位 JD，查看逐条匹配表</li>
        <li>生成定向简历，打印或另存为 PDF</li>
      </ol>
      <Link href="/collect" className="inline-block rounded bg-slate-900 px-4 py-2 text-white">
        开始录入
      </Link>
      <p className="text-xs text-slate-400">数据只保存在你当前浏览器里，可在履历库页导出备份。</p>
    </div>
  );
}
