// 시안(디자인 캔버스)에서 쓴 선 아이콘. 크기·색은 부모를 따른다
import type { ReactNode } from "react";

const I = ({ size = 18, fill, children }: { size?: number; fill?: boolean; children: ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill={fill ? "currentColor" : "none"}
    stroke={fill ? "none" : "currentColor"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);

export const MicIcon = ({ size = 28 }: { size?: number }) => (
  <I size={size}><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0" /><path d="M12 17v5" /></I>
);
/** 앱 로고: 분홍 둥근 사각형 위 흰 N (app/brand/logo.svg와 같은 모양) */
export const LogoMark = ({ size = 30 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true">
    <rect width="1024" height="1024" rx="230" fill="#ff5c8a" />
    <path d="M332 720V304L692 720V304" fill="none" stroke="#fff" strokeWidth="124" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const SearchIcon = () => <I><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></I>;
export const PlusIcon = () => <I><path d="M12 5v14M5 12h14" /></I>;
export const TvIcon = () => <I><rect x="2" y="4" width="20" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></I>;
export const GearIcon = () => (
  <I size={20}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></I>
);
export const WarnIcon = () => <I size={20}><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></I>;
export const NoteIcon = () => <I size={20}><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></I>;
export const CheckIcon = () => <I size={16}><path d="M20 6 9 17l-5-5" /></I>;
export const ToTopIcon = () => <I><path d="M5 4h14" /><path d="m6 14 6-6 6 6" /><path d="M12 8v12" /></I>;
export const XIcon = () => <I><path d="M18 6 6 18M6 6l12 12" /></I>;
export const PlayIcon = ({ size = 20 }: { size?: number }) => <I size={size} fill><path d="M7 4v16l13-8z" /></I>;
export const PauseIcon = () => <I size={22} fill><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></I>;
export const SkipIcon = () => <I size={22} fill><path d="M5 4v16l11-8z" /><rect x="17" y="4" width="3" height="16" rx="1" /></I>;
export const StopIcon = () => <I size={20} fill><rect x="5" y="5" width="14" height="14" rx="2" /></I>;
export const RestartIcon = () => <I size={22}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></I>;
export const BackIcon = () => <I size={20}><path d="m15 18-6-6 6-6" /></I>;
export const LinesIcon = () => <I><path d="M4 6h16M4 12h10M4 18h13" /></I>;
export const PenIcon = () => <I><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></I>;
export const SlidersIcon = () => <I><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" /></I>;
export const ImageIcon = () => <I><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></I>;
export const VideoIcon = () => <I size={16}><rect x="2" y="5" width="20" height="14" rx="3" /><path d="m10 9 5 3-5 3z" /></I>;
export const JumpIcon = () => <I size={22} fill><path d="M4 5v14l8-7zM12 5v14l8-7z" /></I>;
