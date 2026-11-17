import type { MouseEvent, ReactNode } from 'react';

/**
 * 대화를 보낼 수 있는지. 입력창과 헤더 점이 이 상태를 보여준다.
 * 여러 가지가 겹치면 not-editor → other-post → server-down → no-key → no-wood 순으로 하나만 보여준다.
 */
export type Avail = 'checking' | 'ready' | 'not-editor' | 'viewing' | 'other-post' | 'server-down' | 'no-key' | 'no-wood';

export const AVAIL: Record<Avail, { placeholder: string; hint: string; refresh: boolean; dot: DotKind }> = {
  checking: {
    placeholder: '확인 중…',
    hint: '글쓰기 화면과 서버를 확인하고 있어요',
    refresh: false,
    dot: 'off',
  },
  ready: {
    placeholder: '이 글에 대해 요청하기',
    hint: 'Enter 전송 · Shift+Enter 줄바꿈',
    refresh: false,
    dot: 'on',
  },
  'not-editor': {
    placeholder: '블로그 글쓰기 화면이 아니에요',
    hint: '글쓰기나 수정 화면을 연 뒤 새로고침을 눌러 주세요',
    refresh: true,
    dot: 'off',
  },
  viewing: {
    placeholder: '글 보기 화면에서는 대화를 읽기만 할 수 있어요',
    hint: '이 글을 고치려면 수정 화면을 열어 주세요',
    refresh: false,
    dot: 'off',
  },
  'other-post': {
    placeholder: '지금 편집 중인 글의 대화가 아니에요',
    hint: '새로고침을 누르면 편집 중인 글의 대화로 돌아가요',
    refresh: true,
    dot: 'off',
  },
  'server-down': {
    placeholder: '서버에 연결할 수 없어요',
    hint: '기록 보기와 적용, 되돌리기는 계속 돼요',
    refresh: true,
    dot: 'warn',
  },
  'no-key': {
    placeholder: '접근 키가 필요해요',
    hint: '오른쪽 위 계정 화면에서 발급받은 키를 넣어 주세요',
    refresh: true,
    dot: 'warn',
  },
  'no-wood': {
    placeholder: '장작을 다 썼어요',
    hint: '충전을 요청해 주세요. 기록 보기와 적용, 되돌리기는 계속 돼요',
    refresh: true,
    dot: 'warn',
  },
};

type IconName =
  | 'list'
  | 'menu'
  | 'compose'
  | 'library'
  | 'pin'
  | 'user'
  | 'settings'
  | 'tool'
  | 'back'
  | 'close'
  | 'trash'
  | 'refresh'
  | 'chat'
  | 'chevron'
  | 'external';

const PATHS: Record<IconName, ReactNode> = {
  list: <path d="M3 4h10M3 8h10M3 12h7" />,
  menu: <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />,
  compose: <path d="M7 3H3.5v9.5H13V9M11.5 2.5l2 2L8 10H6V8z" />,
  library: (
    <>
      <path d="M2.5 6h11v7.5H2.5z" />
      <path d="M2.5 6l1.2-2.5h8.6L13.5 6" />
      <path d="M6.5 9.5h3" />
    </>
  ),
  pin: (
    <>
      <rect x="3.5" y="7" width="9" height="7" rx="1.2" />
      <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
    </>
  ),
  refresh: <path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5" />,
  chat: <path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z" />,
  chevron: <path d="M6 4l4 4-4 4" />,
  external: <path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5" />,
  user: (
    <>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 13.5c.8-2.3 2.7-3.5 5-3.5s4.2 1.2 5 3.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" />
    </>
  ),
  tool: <path d="M10.5 2.5a3 3 0 0 0-3.4 4L2.8 10.8a1.3 1.3 0 0 0 1.9 1.9L9 8.4a3 3 0 0 0 4-3.4l-1.8 1.8-1.7-.3-.3-1.7z" />,
  back: <path d="M10 3L5 8l5 5" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />,
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {PATHS[name]}
    </svg>
  );
}

export function IconButton({
  name,
  label,
  onClick,
  active,
}: {
  name: IconName;
  label: string;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  /** 켜진 상태 (핀 등) */
  active?: boolean;
}) {
  return (
    <button
      className={`icon-button${active ? ' on' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
    >
      <Icon name={name} />
    </button>
  );
}

export type DotKind = 'on' | 'off' | 'warn';

export function Dot({ kind }: { kind: DotKind }) {
  return <span className={`dot dot-${kind}`} />;
}

export function Header({
  title,
  meta,
  dot,
  left,
  right,
}: {
  title: string;
  meta?: string;
  dot?: DotKind;
  left?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header className="header">
      {left}
      <div className="header-text">
        <div className="header-title">
          {dot && <Dot kind={dot} />}
          <span>{title}</span>
        </div>
        {meta && <div className="header-meta">{meta}</div>}
      </div>
      {right && <div className="header-actions">{right}</div>}
    </header>
  );
}
