import { forwardRef, useEffect, useImperativeHandle, useRef, type ClipboardEvent, type KeyboardEvent } from 'react';
import { asInlineRef, refUri } from '@/lib/composer-refs';
import type { RefItem } from '@blog-helper/shared';

export type ComposerInputHandle = {
  /** 저장된 커서에 칩을 넣는다. replaceAt이면 커서 앞의 @검색어를 지우고 넣는다. */
  insertRef: (ref: RefItem, opts?: { replaceAt?: boolean }) => void;
  read: () => { text: string; refs: RefItem[] };
  clear: () => void;
  /** 글만 갈아끼운다. 슬래시 커맨드를 고를 때 쓴다. */
  setText: (text: string) => void;
  /** 커서 앞의 글. 칩 라벨은 빠진다. @ 피커가 이 문자열을 본다. */
  textBeforeCaret: () => string;
  /** 입력칸에 커서를 둔다 (글 끝). */
  focus: () => void;
};

type Props = {
  disabled?: boolean;
  placeholder?: string;
  /** 질문 카드처럼 좁은 곳에 둘 때 (낮은 높이) */
  compact?: boolean;
  onChange: () => void;
  onPaste?: (e: ClipboardEvent<HTMLDivElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  onFocus?: () => void;
};

const AT_RE = /(?:^|[\s([「『"'“])@([^\s@]*)$/u;

/** 글과 참조 칩을 한 줄에 섞어 쓰는 입력창. React가 내부를 다시 그리지 않는다. */
export const ComposerInput = forwardRef<ComposerInputHandle, Props>(function ComposerInput(
  { disabled, placeholder, compact, onChange, onPaste, onKeyDown, onFocus },
  ref,
) {
  const el = useRef<HTMLDivElement>(null);
  const saved = useRef<Range | null>(null);

  useEffect(() => {
    const onSel = () => {
      const root = el.current;
      const sel = document.getSelection();
      if (!root || !sel?.rangeCount || !root.contains(sel.anchorNode)) return;
      saved.current = sel.getRangeAt(0).cloneRange();
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);

  const markEmpty = () => {
    const root = el.current;
    if (!root) return;
    const { text, refs } = readRoot(root);
    root.classList.toggle('is-empty', !text.trim() && refs.length === 0);
  };

  const notify = () => {
    markEmpty();
    onChange();
  };

  useImperativeHandle(ref, () => ({
    insertRef: (item, opts) => {
      const root = el.current;
      if (!root || disabled) return;
      const remembered = saved.current?.cloneRange() ?? null;
      root.focus();
      const sel = document.getSelection();
      if (!sel) return;
      if (opts?.replaceAt && deleteAtToken(root, remembered)) {
        /* 포커스 뒤에도, 저장해 둔 커서 앞의 @검색어를 지운다 */
      } else if (remembered && root.contains(remembered.startContainer)) {
        sel.removeAllRanges();
        sel.addRange(remembered);
      } else {
        const end = document.createRange();
        end.selectNodeContents(root);
        end.collapse(false);
        sel.removeAllRanges();
        sel.addRange(end);
      }
      const range = sel.rangeCount ? sel.getRangeAt(0) : null;
      if (!range) return;
      range.deleteContents();
      const chip = makeChip(asInlineRef(item), notify);
      range.insertNode(chip);
      const after = document.createRange();
      after.setStartAfter(chip);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
      saved.current = after.cloneRange();
      notify();
    },
    read: () => (el.current ? readRoot(el.current) : { text: '', refs: [] }),
    clear: () => {
      const root = el.current;
      if (!root) return;
      root.replaceChildren();
      saved.current = null;
      notify();
    },
    setText: (text) => {
      const root = el.current;
      if (!root) return;
      root.replaceChildren(document.createTextNode(text));
      const end = document.createRange();
      end.selectNodeContents(root);
      end.collapse(false);
      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(end);
      saved.current = end.cloneRange();
      notify();
    },
    focus: () => {
      const root = el.current;
      if (!root) return;
      root.focus();
      const end = document.createRange();
      end.selectNodeContents(root);
      end.collapse(false);
      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(end);
      saved.current = end.cloneRange();
    },
    textBeforeCaret: () => {
      const root = el.current;
      if (!root) return '';
      const sel = document.getSelection();
      const range =
        sel?.rangeCount && root.contains(sel.anchorNode) ? sel.getRangeAt(0) : saved.current;
      if (!range || !root.contains(range.startContainer)) return root.innerText ?? '';
      return textUntil(root, range);
    },
  }));

  return (
    <div
      ref={el}
      className={`composer-inline is-empty${compact ? ' compact' : ''}`}
      contentEditable={disabled ? 'false' : 'true'}
      role="textbox"
      aria-multiline="true"
      data-placeholder={placeholder}
      onInput={notify}
      onFocus={onFocus}
      onPaste={(e) => {
        const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
        if (files.length) {
          if (onPaste) onPaste(e);
          else e.preventDefault();
          return;
        }
        e.preventDefault();
        insertPlain(e.clipboardData.getData('text/plain'));
        notify();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          insertPlain('\n');
          notify();
          return;
        }
        onKeyDown(e);
      }}
    />
  );
});

function makeChip(item: RefItem, onRemove: () => void): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.className = 'selection-chip composer-inline-chip';
  chip.contentEditable = 'false';
  chip.dataset.ref = JSON.stringify(item);
  const label = document.createElement('span');
  label.textContent = item.label;
  const x = document.createElement('span');
  x.className = 'composer-ref-x';
  x.setAttribute('role', 'button');
  x.setAttribute('aria-label', '빼기');
  x.textContent = '✕';
  x.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    chip.remove();
    onRemove();
  });
  chip.append(label, x);
  return chip;
}

function readRoot(root: HTMLElement): { text: string; refs: RefItem[] } {
  if (root.childNodes.length === 1 && root.firstChild instanceof HTMLBRElement) return { text: '', refs: [] };
  let text = '';
  const refs: RefItem[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? '';
      return;
    }
    if (node instanceof HTMLElement && node.dataset.ref) {
      const ref = parseRef(node.dataset.ref);
      const uri = ref && refUri(ref);
      if (ref && uri) {
        text += uri;
        refs.push(ref);
      }
      return;
    }
    if (node instanceof HTMLBRElement) {
      text += '\n';
      return;
    }
    node.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return { text, refs };
}

function parseRef(raw: string): RefItem | null {
  try {
    const r = JSON.parse(raw) as RefItem;
    if (!r || typeof r !== 'object' || typeof r.label !== 'string') return null;
    if (!r.doc && !r.lib) return null;
    return r;
  } catch {
    return null;
  }
}

/** range 시작 앞까지의 글. 칩은 건너뛴다. */
function textUntil(root: HTMLElement, range: Range): string {
  let out = '';
  const stop = range.startContainer;
  const offset = range.startOffset;
  const appendAll = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? '';
      return;
    }
    if (node instanceof HTMLElement && node.dataset.ref) return;
    if (node instanceof HTMLBRElement) {
      out += '\n';
      return;
    }
    node.childNodes.forEach(appendAll);
  };
  const visit = (node: Node): boolean => {
    if (node === stop) {
      if (node.nodeType === Node.TEXT_NODE) out += (node.textContent ?? '').slice(0, offset);
      else {
        for (let i = 0; i < offset && i < node.childNodes.length; i++) appendAll(node.childNodes[i]);
      }
      return true;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? '';
      return false;
    }
    if (node instanceof HTMLElement && node.dataset.ref) return false;
    if (node instanceof HTMLBRElement) {
      out += '\n';
      return false;
    }
    for (const child of node.childNodes) {
      if (visit(child)) return true;
    }
    return false;
  };
  visit(root);
  return out;
}

/** 커서가 놓인 글자 노드와 그 안에서의 위치. 노드 경계에 있으면 바로 앞 글자 노드. */
function caretTextPoint(range: Range): { node: Text; offset: number } | null {
  const c = range.startContainer;
  if (c.nodeType === Node.TEXT_NODE) return { node: c as Text, offset: range.startOffset };
  if (range.startOffset > 0) {
    const prev = c.childNodes[range.startOffset - 1];
    if (prev?.nodeType === Node.TEXT_NODE) return { node: prev as Text, offset: (prev.textContent ?? '').length };
  }
  return null;
}

/** 커서 바로 앞의 @검색어를 지운다. 지웠으면 true. */
function deleteAtToken(root: HTMLElement, remembered: Range | null): boolean {
  if (!remembered || !root.contains(remembered.startContainer)) return false;
  const point = caretTextPoint(remembered);
  if (!point) return false;
  const before = (point.node.textContent ?? '').slice(0, point.offset);
  const m = AT_RE.exec(before);
  if (!m) return false;
  const start = point.offset - m[1].length - 1;
  if (start < 0) return false;
  const range = document.createRange();
  range.setStart(point.node, start);
  range.setEnd(point.node, point.offset);
  range.deleteContents();
  const next = document.getSelection();
  if (!next) return true;
  const caret = document.createRange();
  caret.setStart(point.node, start);
  caret.collapse(true);
  next.removeAllRanges();
  next.addRange(caret);
  return true;
}

function insertPlain(text: string) {
  const sel = document.getSelection();
  if (!sel?.rangeCount) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  const after = document.createRange();
  after.setStartAfter(node);
  after.collapse(true);
  sel.removeAllRanges();
  sel.addRange(after);
}
