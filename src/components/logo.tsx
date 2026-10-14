/** 有据简历 Logo：一张简历纸 + 右下角对勾圆章 */
export function Logo({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden className={className}>
      <rect x="5" y="3" width="18" height="24" rx="3.5" fill="#e6f4f1" stroke="#0f766e" strokeWidth="2" />
      <path d="M9.5 9.5h9M9.5 14h9M9.5 18.5h5" stroke="#0f766e" strokeWidth="2" strokeLinecap="round" />
      <circle cx="23" cy="23" r="6.5" fill="#0f766e" stroke="#fff" strokeWidth="2" />
      <path d="m20.2 23 1.9 1.9 3.7-3.8" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
