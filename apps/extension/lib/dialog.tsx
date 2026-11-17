/**
 * 사이드 패널 안 다이얼로그. 브라우저 confirm·alert 대신 쓴다 (뒤를 어둡게 덮고 가운데 띄운다).
 * confirmDialog·alertDialog는 Promise로 답을 돌려주고, DialogHost가 화면에 그린다.
 */
import { useEffect, useRef, useState } from 'react';

type DialogRequest = {
  id: number;
  title?: string;
  message: string;
  /** 확인 버튼 글 */
  ok: string;
  /** 취소 버튼 글 (없으면 알림: 확인만) */
  cancel?: string;
  /** 지우기처럼 되돌릴 수 없는 일이면 확인 버튼을 빨갛게 */
  danger?: boolean;
  resolve: (ok: boolean) => void;
};

let seq = 0;
let queue: DialogRequest[] = [];
const listeners = new Set<(q: DialogRequest[]) => void>();
const emit = () => listeners.forEach((fn) => fn(queue));

function open(req: Omit<DialogRequest, 'id' | 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    queue = [...queue, { ...req, id: ++seq, resolve }];
    emit();
  });
}

/** 확인·취소를 묻는다. 확인이면 true */
export function confirmDialog(
  message: string,
  opts: { title?: string; ok?: string; cancel?: string; danger?: boolean } = {},
): Promise<boolean> {
  return open({ message, title: opts.title, ok: opts.ok ?? '확인', cancel: opts.cancel ?? '취소', danger: opts.danger });
}

/** 알린다 (확인 버튼만) */
export async function alertDialog(message: string, opts: { title?: string } = {}): Promise<void> {
  await open({ message, title: opts.title, ok: '확인' });
}

/** 앱 맨 위에 한 번 둔다. */
export function DialogHost() {
  const [items, setItems] = useState<DialogRequest[]>(queue);
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    listeners.add(setItems);
    return () => {
      listeners.delete(setItems);
    };
  }, []);
  const top = items[0];
  useEffect(() => {
    okRef.current?.focus();
  }, [top?.id]);
  if (!top) return null;
  const close = (ok: boolean) => {
    queue = queue.filter((q) => q.id !== top.id);
    emit();
    top.resolve(ok);
  };
  return (
    <div className="dialog-layer" onKeyDown={(e) => e.key === 'Escape' && close(false)}>
      <div className="dialog-dim" onClick={() => close(false)} />
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby={`dlg-${top.id}`}>
        {top.title && <strong className="dialog-title">{top.title}</strong>}
        <p id={`dlg-${top.id}`} className="dialog-text">
          {top.message}
        </p>
        <div className="dialog-actions">
          {top.cancel && (
            <button type="button" onClick={() => close(false)}>
              {top.cancel}
            </button>
          )}
          <button ref={okRef} type="button" className={top.danger ? 'danger' : 'primary'} onClick={() => close(true)}>
            {top.ok}
          </button>
        </div>
      </div>
    </div>
  );
}
