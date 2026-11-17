import { useEffect, useState } from 'react';
import type {
  BroadcastMessage,
  ClipboardDump,
  EditorProbe,
  ImagePasteAttempt,
  PasteTestResult,
  SelectionProbe,
} from '@/lib/messages';
import type { CaretTestResult, DocumentDataResult, ExploreResult, UploadTrace, WriteTestResult } from '@/lib/main-bridge';
import { readDocument, sendToEditor, writeDocument, type FrameTarget } from '@/lib/editor-client';
import { checkHealth, connection, describeImages, editImage, SERVERS, type Connection } from '@/lib/server';
import { saveSettings, type ServerChoice } from '@/lib/settings';
import type { HealthResponse, ImageInput } from '@blog-helper/shared';
import { Dot } from './ui';
import { renderBlocks } from '@/lib/render-image';
import { formulaFields, renderFormula } from '@/lib/formula';
import { uploadImage } from '@/lib/image-upload';
import { applyBatch, BlockRefs, blockText, makeComponent, newId, type SeComponent, type SeDocumentData } from '@blog-helper/se-model';

function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function DevTools({ onServerChanged }: { onServerChanged: () => void }) {
  return (
    <>
      <ServerSection onServerChanged={onServerChanged} />
      <ProbeSection />
      <ExploreSection />
      <WriteTestSection />
      <ImageInsertSection />
      <ClipboardSection />
      <IdCheckSection />
      <VisualSection />
      <SelectionSection />
      <FormulaSection />
      <CaretSection />
      <UploadTraceSection />
    </>
  );
}

const UPLOAD_HINT = /upphoto|upload|photo|pstatic|image/i;

/** 사진 한 장을 붙여넣으며 네트워크 요청과 문서 변경을 시간순으로 기록한다. */
function UploadTraceSection() {
  const [original, setOriginal] = useState<SeDocumentData | null>(null);
  const [log, setLog] = useState('');
  const [busy, setBusy] = useState(false);

  const trace = async () => {
    setBusy(true);
    setLog('추적 중… (약 10초)');
    try {
      const start = await readDocument();
      if (!original) setOriginal(start);
      const before = new Set(start.document.components.map((c) => c.id));
      const { t0 } = await sendToEditor<{ t0: number }>({ type: 'trace-start' });
      const marks: { t: number; text: string }[] = [];
      const mark = (text: string) => marks.push({ t: Math.round(Date.now() - t0), text });

      mark('붙여넣기 보냄');
      const dataUrl = await blobToDataUrl(await makeTestImage());
      const attempts = await sendToEditor<ImagePasteAttempt[]>({ type: 'image-paste-test', dataUrl });
      mark(`붙여넣기 이벤트 끝 (${attempts.map((a) => a.where).join(', ')})`);

      let last = '';
      let stableSince = Date.now();
      let gotSrc = false;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const comps = (await readDocument()).document.components;
        const added = comps.find((c) => !before.has(c.id) && c['@ctype'] === 'image');
        const uploaded = added && typeof added.src === 'string' && /^https?:/.test(added.src);
        if (uploaded && !gotSrc) {
          gotSrc = true;
          mark('새 사진에 http 주소가 생김');
        }
        const snapshot = JSON.stringify(comps);
        if (snapshot !== last) {
          last = snapshot;
          stableSince = Date.now();
        } else if (uploaded && Date.now() - stableSince >= 1500) {
          mark('지금 방식의 완료 판정 (1.5초 동안 그대로)');
          break;
        }
        await sleep(100);
      }
      await sleep(4000);
      mark('추적 끝 (판정 뒤 4초 더 봄)');
      const t = await sendToEditor<UploadTrace>({ type: 'trace-stop' });

      const shortUrl = (u: string) => {
        try {
          const url = new URL(u);
          return `${url.host}${url.pathname}`.slice(0, 90);
        } catch {
          return u.slice(0, 90);
        }
      };
      const rows = [
        ...marks.map((m) => ({ t: m.t, text: `◆ ${m.text}` })),
        ...t.doc.map((d) => ({ t: d.t, text: `▣ 문서 변경 (${d.summary}): ${d.changed}` })),
        ...t.network.map((n) => ({
          t: n.end,
          text: `${UPLOAD_HINT.test(n.url) ? '★' : '·'} 요청 끝 ${n.initiator} ${n.status ?? ''} ${shortUrl(n.url)} (시작 ${n.start}ms, ${n.end - n.start}ms 걸림${n.size ? `, ${n.size}B` : ''})`,
        })),
      ].sort((a, b) => a.t - b.t);
      setLog(
        [
          `◆ 확장의 판단  ▣ 에디터 문서 변경  ★ 업로드 관련으로 보이는 요청  · 그 밖의 요청`,
          `요청 ${t.network.length}개 · 문서 변경 ${t.doc.length}번`,
          '',
          ...rows.map((r) => `${String(r.t).padStart(6)}ms  ${r.text}`),
        ].join('\n'),
      );
    } catch (e) {
      await sendToEditor({ type: 'trace-stop' }).catch(() => {});
      setLog(`실패\n${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!original) return;
    await writeDocument(original);
    setOriginal(null);
    setLog('처음 상태로 되돌렸습니다.');
  };

  return (
    <section>
      <h2>12. 업로드 추적 실험</h2>
      <p className="muted">
        임시 글에서 해주세요. 에디터에서 사진이 들어갈 자리를 클릭해 두고 누르면, 테스트 사진 한 장을 붙여넣으며 그동안의 네트워크 요청과
        문서 변경을 시간순으로 보여 줍니다. 약 10초 걸립니다.
      </p>
      <div className="row">
        <button disabled={busy} onClick={trace}>사진 붙여넣고 추적</button>
        <button disabled={busy || !original} onClick={restore}>되돌리기</button>
        {log && !busy && <button onClick={() => navigator.clipboard.writeText(log)}>결과 복사</button>}
      </div>
      {log && <pre>{log}</pre>}
    </section>
  );
}

const PLACEHOLDER = '[blsee 자리]';

/** 표시 블록에 커서를 옮기고 그 자리에 붙여넣기가 되는지 확인한다. */
function CaretSection() {
  const [after, setAfter] = useState(3);
  const [original, setOriginal] = useState<SeDocumentData | null>(null);
  const [placeholderId, setPlaceholderId] = useState<string | null>(null);
  const [log, setLog] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (label: string, task: () => Promise<string>) => {
    setBusy(true);
    setLog(`${label}…`);
    try {
      setLog(`${label}\n${await task()}`);
    } catch (e) {
      setLog(`${label} 실패\n${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const moveCaret = () =>
    run('A. 표시 블록 넣고 커서 옮기기', async () => {
      const before = await readDocument();
      if (!original) setOriginal(before);
      const comps = before.document.components;
      if (after < 0 || after >= comps.length) throw new Error(`블록 번호는 0~${comps.length - 1}입니다.`);
      const mark = makeComponent('text', { paragraphs: [PLACEHOLDER] });
      const draft = structuredClone(before);
      draft.document.components.splice(after + 1, 0, mark);
      await writeDocument(draft);
      await sleep(800);
      setPlaceholderId(mark.id);
      const r = await sendToEditor<CaretTestResult>({ type: 'caret-test', compId: mark.id });
      return [
        `표시 블록 [${after + 1}] ${short(mark.id)}`,
        r.landedBy ? `→ 커서 옮기기 성공: ${r.landedBy}` : '→ 커서를 옮기지 못했습니다.',
        '',
        ...r.tried.map((t) => `${t.landed ? '✓' : '✗'} ${t.how}${t.error ? ` (오류: ${t.error})` : ''}\n  선택: ${t.selection}`),
        '',
        `커서 관련 메서드 ${r.setters.length}개:`,
        ...r.setters.slice(0, 40).map((s) => `  ${s}`),
      ].join('\n');
    });

  const pasteHere = () =>
    run('B. 그 자리에 사진 붙여넣기', async () => {
      if (!placeholderId) throw new Error('먼저 A를 눌러 주세요.');
      const before = new Set((await readDocument()).document.components.map((c) => c.id));
      const attempts = await sendToEditor<ImagePasteAttempt[]>({
        type: 'image-paste-test',
        dataUrl: await blobToDataUrl(await makeTestImage()),
      });
      for (let t = 0; t < 30; t++) {
        await sleep(500);
        const comps = (await readDocument()).document.components;
        const k = comps.findIndex((c) => !before.has(c.id) && c['@ctype'] === 'image');
        if (k < 0) continue;
        const p = comps.findIndex((c) => c.id === placeholderId);
        const where = p < 0 ? '표시 블록이 사라짐' : k === p + 1 ? '표시 블록 바로 뒤' : k === p - 1 ? '표시 블록 바로 앞' : '표시 블록과 떨어진 곳';
        return `새 사진 [${k}] · 표시 블록 [${p}] → ${where}\n블록 ${comps.length}개 중 [${k}]가 끝에서 ${comps.length - 1 - k}번째\n${JSON.stringify(attempts)}`;
      }
      throw new Error(`15초 안에 사진이 생기지 않았습니다.\n${JSON.stringify(attempts)}`);
    });

  const restore = () =>
    run('되돌리기', async () => {
      if (!original) throw new Error('되돌릴 원본이 없습니다.');
      await writeDocument(original);
      setOriginal(null);
      setPlaceholderId(null);
      return '처음 상태로 되돌렸습니다.';
    });

  return (
    <section>
      <h2>11. 커서 옮기기 실험</h2>
      <p className="muted">
        임시 글에서 해주세요. 블록 N 뒤에 "{PLACEHOLDER}" 문단을 넣고 커서를 그곳으로 옮긴 뒤(A), 사진을 붙여넣어 그 자리에 들어가는지(B)
        봅니다. A 전에 에디터의 다른 곳(예: 맨 끝)을 클릭해 두면 커서가 실제로 옮겨졌는지 구별하기 쉽습니다.
      </p>
      <div className="row">
        <label>
          블록 <input type="number" min={0} value={after} onChange={(e) => setAfter(Number(e.target.value))} style={{ width: 48 }} /> 뒤에
        </label>
        <button disabled={busy} onClick={moveCaret}>A. 표시 블록 넣고 커서 옮기기</button>
        <button disabled={busy || !placeholderId} onClick={pasteHere}>B. 사진 붙여넣기</button>
        <button disabled={busy || !original} onClick={restore}>되돌리기</button>
      </div>
      {log && <pre>{log}</pre>}
    </section>
  );
}

function describeFormula(c: SeComponent, index: number): string {
  const html = typeof c.html === 'string' ? c.html : '';
  const thumb = c.thumbnail as { src?: string; width?: number; height?: number } | undefined;
  const shown = /\$(.*?)\$/s.exec(html)?.[1];
  return [
    `[${index}] ${short(c.id)} latex: ${JSON.stringify(c.latex)}`,
    `  html: ${html ? `${html.length}자, 안의 수식 ${JSON.stringify(shown ?? '?')}` : '없음'}`,
    `  thumbnail: ${thumb?.src ? `${thumb.width}×${thumb.height} ${thumb.src.slice(-40)}` : '없음'}`,
    `  나머지 키: ${Object.keys(c).filter((k) => !['id', 'latex', 'html', 'thumbnail', '@ctype'].includes(k)).join(', ')}`,
  ].join('\n');
}

function formulaReport(doc: SeDocumentData): string {
  const comps = doc.document.components;
  const formulas = comps.flatMap((c, i) => (c['@ctype'] === 'formula' ? [describeFormula(c, i)] : []));
  const images = comps.flatMap((c, i) => (c['@ctype'] === 'image' ? [`[${i}] ${short(c.id)} ${String(c.src).slice(-40)}`] : []));
  const tail = comps.slice(-5).map((c, i) => `[${comps.length - 5 + i}] ${c['@ctype']}`);
  return [
    formulas.join('\n') || '수식 블록 없음',
    `사진 블록 ${images.length}개${images.length ? `\n  ${images.join('\n  ')}` : ''}`,
    `끝 블록 순서: ${tail.join(' · ')}`,
  ].join('\n');
}

/** 에디터가 latex만 보고 html·thumbnail을 다시 만드는지 확인한다. */
function FormulaSection() {
  const [latex, setLatex] = useState('\\frac{a+b}{2}=\\sqrt{x^2+1}');
  const [original, setOriginal] = useState<SeDocumentData | null>(null);
  const [png, setPng] = useState<Shot | null>(null);
  const [log, setLog] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (label: string, task: () => Promise<string>) => {
    setBusy(true);
    setLog(`${label}…`);
    try {
      setLog(`${label}\n${await task()}`);
    } catch (e) {
      setLog(`${label} 실패\n${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const labels = {
    bare: 'A. latex만 넣기',
    stale: 'B. 기존 수식 복사 + latex만 교체',
    thumbOnly: 'C. 기존 수식 복사 + html 제거',
    htmlOnly: 'D. 기존 수식 복사 + thumbnail 제거',
  } as const;

  const insert = (mode: keyof typeof labels) =>
    run(labels[mode], async () => {
      const before = await readDocument();
      const comps = before.document.components;
      let formula: SeComponent;
      if (mode === 'bare') {
        formula = { id: newId(), layout: 'default', latex, fontSizeCode: 'fs15', fontFamily: 'system', '@ctype': 'formula' };
      } else {
        const src = comps.find((c) => c['@ctype'] === 'formula');
        if (!src) throw new Error('문서에 수식이 하나 이상 있어야 합니다. 에디터 "수식" 메뉴로 하나 넣어 주세요.');
        formula = { ...structuredClone(src), id: newId(), latex };
        if (mode === 'thumbOnly') delete formula.html;
        if (mode === 'htmlOnly') delete formula.thumbnail;
      }
      if (!original) setOriginal(before);
      const draft = structuredClone(before);
      draft.document.components.push(formula);
      await writeDocument(draft);
      await sleep(1000);
      const after = await readDocument();
      const got = after.document.components.findIndex((c) => c.id === formula.id);
      return [
        `넣은 ID ${short(formula.id)} → ${got >= 0 ? `[${got}]에 있음` : '다시 읽으니 없음 (ID가 바뀌었거나 거부됨)'}`,
        '',
        formulaReport(after),
        '',
        '에디터 맨 끝에서 수식이 제대로 보이는지 확인해 주세요. 그다음 수식을 더블클릭해 편집창에 뜨는 값을 보고,',
        '임시저장 후 "다시 읽기"를 눌러 html·thumbnail이 새로 생겼는지 봐 주세요.',
      ].join('\n');
    });

  const reread = () => run('다시 읽기', async () => formulaReport(await readDocument()));

  const preview = () =>
    run('E-1. 그려 보기', async () => {
      const r = await renderFormula(latex);
      setPng(await makeShot(`수식 ${r.width}×${r.height}`, r.blob));
      return `${r.width}×${r.height}px · ${(r.blob.size / 1024).toFixed(1)}KB`;
    });

  const renderAndInsert = () =>
    run('E-2. 그려서 올리고 수식 넣기', async () => {
      const r = await renderFormula(latex);
      setPng(await makeShot(`수식 ${r.width}×${r.height}`, r.blob));
      const before = await readDocument();
      if (!original) setOriginal(before);
      const uploaded = await uploadImage(r.blob);
      const src = String(uploaded.src);
      const doc = await readDocument();
      const formula: SeComponent = {
        id: newId(),
        layout: 'default',
        latex,
        fontSizeCode: 'fs15',
        fontFamily: 'system',
        ...formulaFields(src, r),
        '@ctype': 'formula',
      };
      doc.document.components = doc.document.components.filter((c) => c.id !== uploaded.id);
      doc.document.components.push(formula);
      await writeDocument(doc);
      const watch: string[] = [];
      let after = doc;
      for (let t = 1; t <= 6; t++) {
        await sleep(1000);
        after = await readDocument();
        const comps = after.document.components;
        const has = comps.some((c) => c.id === formula.id);
        const formulas = comps.filter((c) => c['@ctype'] === 'formula').length;
        const leftover = comps.some((c) => c.id === uploaded.id);
        watch.push(`${t}초: 넣은 수식 ${has ? '있음' : '없음'} · 수식 ${formulas}개 · 블록 ${comps.length}개${leftover ? ' · 업로드 사진 남음' : ''}`);
      }
      return [
        `업로드: ${src}`,
        ...watch,
        '',
        formulaReport(after),
        '',
        '맨 끝 수식이 보이는지, 클릭해서 선택되는지, 더블클릭하면 편집창에 latex가 뜨는지 봐 주세요.',
      ].join('\n');
    });

  const findTools = () =>
    run('페이지 수식 도구 찾기', async () => {
      const names = ['MathQuill', 'MathJax', 'katex', 'html2canvas', 'domtoimage', 'htmlToImage', 'lama', 'LAMA', 'Lama'];
      const lines = await Promise.all(
        names.map(async (name) => {
          try {
            const r = await sendToEditor<ExploreResult>({ type: 'explore', path: name });
            if (r.type === 'undefined') return `${name}: 없음`;
            return `${name}: ${r.type} ${r.detail}\n  ${r.entries.slice(0, 30).map((e) => e.name).join(', ')}`;
          } catch (e) {
            return `${name}: 오류 ${String(e)}`;
          }
        }),
      );
      return lines.join('\n');
    });

  const restore = () =>
    run('되돌리기', async () => {
      if (!original) throw new Error('되돌릴 원본이 없습니다.');
      await writeDocument(original);
      setOriginal(null);
      return '처음 상태로 되돌렸습니다.';
    });

  return (
    <section>
      <h2>10. 수식 넣기 실험</h2>
      <p className="muted">
        임시 글에서 해주세요. 문서 맨 끝에 수식 블록을 넣고 에디터가 html·그림(thumbnail)을 다시 만드는지 봅니다.
        B는 문서에 수식이 하나 있어야 합니다.
      </p>
      <div className="row">
        <input value={latex} onChange={(e) => setLatex(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
      </div>
      <div className="row">
        <button disabled={busy} onClick={() => insert('bare')}>A. latex만</button>
        <button disabled={busy} onClick={() => insert('stale')}>B. 복사 + latex 교체</button>
        <button disabled={busy} onClick={() => insert('thumbOnly')}>C. 복사 + html 제거</button>
        <button disabled={busy} onClick={() => insert('htmlOnly')}>D. 복사 + thumbnail 제거</button>
      </div>
      <div className="row">
        <button disabled={busy} onClick={preview}>E-1. 그려 보기</button>
        <button disabled={busy} onClick={renderAndInsert}>E-2. 그려서 올리고 넣기</button>
      </div>
      <div className="row">
        <button disabled={busy} onClick={findTools}>페이지 수식 도구 찾기</button>
        <button disabled={busy} onClick={reread}>다시 읽기</button>
        <button disabled={busy || !original} onClick={restore}>되돌리기</button>
      </div>
      {png && (
        <figure>
          <img src={png.url} alt={png.label} style={{ border: '1px solid #ddd' }} />
          <figcaption className="muted">{png.label}</figcaption>
        </figure>
      )}
      {log && <pre>{log}</pre>}
    </section>
  );
}

function SelectionSection() {
  const [result, setResult] = useState<SelectionProbe | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);

  const probe = async (delayMs: number) => {
    setError(null);
    setResult(null);
    try {
      for (let left = delayMs / 1000; left > 0; left--) {
        setStatus(`${left}초 뒤 확인합니다. 지금 에디터에서 글자를 클릭하거나 선택하세요.`);
        await sleep(1000);
      }
      setStatus('확인 중…');
      setResult(await sendToEditor<SelectionProbe>({ type: 'selection-probe' }));
      setStatus('');
    } catch (e) {
      setStatus('');
      setError(String(e));
    }
  };

  const model = result && !('error' in result.model) ? result.model : null;

  return (
    <section>
      <h2>9. 커서·선택 위치 확인</h2>
      <p className="muted">
        에디터에서 글자 일부를 드래그로 선택하거나 커서를 둔 뒤 누르세요. 버튼을 누르면 에디터 선택이 풀릴 수 있으니, 그때는
        "3초 뒤"를 누르고 에디터로 돌아가 선택하세요.
      </p>
      <div className="row">
        <button onClick={() => probe(0)}>지금 확인</button>
        <button onClick={() => probe(3000)}>3초 뒤 확인</button>
        {result && <button onClick={() => downloadJson('selection-probe.json', result)}>JSON 저장</button>}
      </div>
      {status && <p className="muted">{status}</p>}
      {error && <p className="error">{error}</p>}
      {result && (
        <>
          <h3>브라우저 선택 영역</h3>
          <pre>
            {result.dom.selections
              .map(
                (s) =>
                  `${s.frame}: ${s.type} · 블록 ${s.component ?? '-'} · ${s.anchor} @${s.anchorOffset}~${s.focusOffset}` +
                  (s.text ? `\n  선택 글자: "${s.text}"` : ''),
              )
              .join('\n') || '없음'}
          </pre>
          <h3>선택/커서 표시 요소 ({result.dom.marks.length})</h3>
          <pre>
            {result.dom.marks.map((m) => `블록 ${m.component ?? '-'} · .${m.className} · ${m.text}`).join('\n') || '없음'}
          </pre>
          <h3>에디터 객체</h3>
          {'error' in result.model ? (
            <p className="error">{result.model.error}</p>
          ) : (
            <>
              <pre>
                {model!.calls.map((c) => `${c.ok ? '' : '✗ '}${c.path}\n  → ${c.value}`).join('\n') || '불러 본 메서드 없음'}
              </pre>
              <details>
                <summary>관련 메서드 {model!.methods.length}개</summary>
                <pre>{model!.methods.join('\n')}</pre>
              </details>
            </>
          )}
        </>
      )}
    </section>
  );
}

interface Shot {
  label: string;
  blob: Blob;
  url: string;
  width: number;
  height: number;
  note?: string;
}

async function makeShot(label: string, blob: Blob, note?: string): Promise<Shot> {
  const bmp = await createImageBitmap(blob);
  const shot = { label, blob, url: URL.createObjectURL(blob), width: bmp.width, height: bmp.height, note };
  bmp.close();
  return shot;
}

async function toImageInput(blob: Blob): Promise<ImageInput> {
  const dataUrl = await blobToDataUrl(blob);
  return { mimeType: blob.type || 'image/png', data: dataUrl.slice(dataUrl.indexOf(',') + 1) };
}

interface ImageBlock {
  index: number;
  src: string;
  label: string;
}

function imageBlocks(doc: SeDocumentData): ImageBlock[] {
  return doc.document.components.flatMap((c, index) => {
    if (c['@ctype'] !== 'image' || typeof c.src !== 'string') return [];
    const size = c.width && c.height ? ` ${c.width}×${c.height}` : '';
    return [{ index, src: c.src, label: `${index}번 ${String(c.fileName ?? '')}${size}` }];
  });
}

/** 원본에 가까운 크기를 먼저, 안 되면 붙어 있던 주소 그대로 시도한다. */
function srcCandidates(src: string): string[] {
  const bare = src.split('?')[0];
  return [...new Set([bare, `${bare}?type=w966`, src])];
}

const LOOK_QUESTION =
  '네이버 블로그 글 일부를 그린 이미지야. 보이는 모양을 설명해줘: 글자 크기와 굵기, 색, 정렬, 줄 간격과 여백, 인용구·구분선·표 같은 꾸밈의 모양, 전체적으로 읽기 편한지. 짧게 항목으로.';

function VisualSection() {
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(3);
  const [images, setImages] = useState<ImageBlock[] | null>(null);
  const [pick, setPick] = useState(0);
  const [instruction, setInstruction] = useState('이 이미지를 따뜻한 수채화 느낌으로 바꿔줘. 구도와 내용은 그대로.');
  const [shot, setShot] = useState<Shot | null>(null);
  const [source, setSource] = useState<Shot | null>(null);
  const [edited, setEdited] = useState<Shot | null>(null);
  const [log, setLog] = useState<string>('');
  const [busy, setBusy] = useState(false);

  const run = async (label: string, task: () => Promise<string>) => {
    setBusy(true);
    setLog(`${label}…`);
    const t = performance.now();
    try {
      const out = await task();
      setLog(`${label} (${((performance.now() - t) / 1000).toFixed(1)}초)\n${out}`);
    } catch (e) {
      setLog(`${label} 실패\n${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const drawBlocks = () =>
    run(`A. 블록 ${from}~${to} 그리기`, async () => {
      const doc = await readDocument();
      const r = await renderBlocks(doc, from, to);
      setShot(await makeShot(`블록 ${from}~${to} (데이터로 그림, 1/${r.pngs.length})`, r.pngs[0]));
      const kb = r.pngs.reduce((n, b) => n + b.size, 0) / 1024;
      return [
        `${r.width}×${r.height}px · PNG ${r.pngs.length}장 ${kb.toFixed(0)}KB · HTML ${(r.html.length / 1024).toFixed(0)}KB`,
        `전체 컴포넌트 ${doc.document.components.length}개`,
        r.missingImages ? `이미지 ${r.missingImages}개를 못 받아 회색으로 그렸습니다.` : '',
      ]
        .filter(Boolean)
        .join('\n');
    });

  const askLook = () =>
    run('A-2. Gemini에게 모양 묻기', async () => {
      if (!shot) throw new Error('먼저 블록을 그리세요.');
      const res = await describeImages({ images: [await toImageInput(shot.blob)], question: LOOK_QUESTION });
      return `[${res.model}]\n${res.text}`;
    });

  const listImages = () =>
    run('C-1. 이미지 블록 찾기', async () => {
      const list = imageBlocks(await readDocument());
      setImages(list);
      setPick(0);
      return list.length ? list.map((b) => `${b.label}\n  ${b.src}`).join('\n') : '이미지 블록이 없습니다.';
    });

  const fetchImage = () =>
    run('C-2. 이미지 파일 가져오기', async () => {
      const target = images?.[pick];
      if (!target) throw new Error('먼저 이미지 블록을 찾으세요.');
      const lines: string[] = [];
      for (const url of srcCandidates(target.src)) {
        try {
          const res = await fetch(url, { credentials: 'omit' });
          const blob = await res.blob();
          lines.push(`${res.status} ${blob.type || '?'} ${(blob.size / 1024).toFixed(0)}KB ← ${url}`);
          if (res.ok && blob.type.startsWith('image/')) {
            setSource(await makeShot(`원본 (${target.label})`, blob));
            lines.push('→ 이 파일을 씁니다.');
            return lines.join('\n');
          }
        } catch (e) {
          lines.push(`실패 ${String(e)} ← ${url}`);
        }
      }
      throw new Error(lines.join('\n'));
    });

  const askImage = () =>
    run('C-3. Gemini에게 이미지 설명 듣기', async () => {
      if (!source) throw new Error('먼저 이미지 파일을 가져오세요.');
      const res = await describeImages({
        images: [await toImageInput(source.blob)],
        question: '블로그에 첨부된 사진이야. 무엇이 보이는지 2~3문장으로 설명해줘.',
      });
      return `[${res.model}]\n${res.text}`;
    });

  const transform = () =>
    run('D-1. Gemini로 변형', async () => {
      if (!source) throw new Error('먼저 이미지 파일을 가져오세요.');
      const res = await editImage({ image: await toImageInput(source.blob), instruction });
      if (!res.image) throw new Error(`[${res.model}] 이미지 없음\n${res.text}`);
      const blob = await (await fetch(`data:${res.image.mimeType};base64,${res.image.data}`)).blob();
      const s = await makeShot('변형 결과', blob);
      setEdited(s);
      return `[${res.model}] ${s.width}×${s.height}px · ${(blob.size / 1024).toFixed(0)}KB\n${res.text}`;
    });

  const insert = () =>
    run('D-2. 에디터에 넣기', async () => {
      if (!edited) throw new Error('먼저 변형하세요.');
      const attempts = await sendToEditor<ImagePasteAttempt[]>({
        type: 'image-paste-test',
        dataUrl: await blobToDataUrl(edited.blob),
      });
      return JSON.stringify(attempts, null, 2);
    });

  return (
    <section>
      <h2>8. 화면·이미지 확인</h2>
      <p className="muted">
        블록 번호는 문서 데이터의 components 순서입니다 (0번은 제목). 에디터 탭이 화면에 보이는 상태에서 누르세요.
      </p>
      <div className="row">
        <label>
          블록 <input type="number" min={0} value={from} onChange={(e) => setFrom(Number(e.target.value))} style={{ width: 48 }} />
        </label>
        <label>
          ~ <input type="number" min={0} value={to} onChange={(e) => setTo(Number(e.target.value))} style={{ width: 48 }} />
        </label>
        <button disabled={busy} onClick={drawBlocks}>A. 블록 그리기</button>
        <button disabled={busy || !shot} onClick={askLook}>A-2. 모양 묻기</button>
      </div>
      {shot && (
        <figure>
          <img src={shot.url} alt={shot.label} style={{ maxWidth: '100%', border: '1px solid #ddd' }} />
          <figcaption className="muted">{shot.label} · {shot.width}×{shot.height}</figcaption>
        </figure>
      )}

      <div className="row">
        <button disabled={busy} onClick={listImages}>C-1. 이미지 블록 찾기</button>
        {images && images.length > 0 && (
          <select value={pick} onChange={(e) => setPick(Number(e.target.value))}>
            {images.map((b, i) => (
              <option key={b.index} value={i}>{b.label}</option>
            ))}
          </select>
        )}
        <button disabled={busy || !images?.length} onClick={fetchImage}>C-2. 파일 가져오기</button>
        <button disabled={busy || !source} onClick={askImage}>C-3. 설명 듣기</button>
      </div>
      {source && (
        <figure>
          <img src={source.url} alt={source.label} style={{ maxWidth: '100%' }} />
          <figcaption className="muted">{source.label} · {source.width}×{source.height} · {(source.blob.size / 1024).toFixed(0)}KB</figcaption>
        </figure>
      )}

      <div className="row">
        <input value={instruction} onChange={(e) => setInstruction(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
        <button disabled={busy || !source} onClick={transform}>D-1. 변형</button>
        <button disabled={busy || !edited} onClick={insert}>D-2. 에디터에 넣기</button>
      </div>
      {edited && (
        <figure>
          <img src={edited.url} alt={edited.label} style={{ maxWidth: '100%' }} />
          <figcaption className="muted">{edited.label} · {edited.width}×{edited.height}</figcaption>
        </figure>
      )}
      {log && <pre>{log}</pre>}
    </section>
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function duplicateIds(doc: SeDocumentData): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const c of doc.document.components) {
    if (seen.has(c.id)) dups.add(c.id);
    seen.add(c.id);
  }
  return [...dups];
}

function paragraphIds(c: SeComponent | undefined): string[] {
  return Array.isArray(c?.value) ? (c.value as { id: string }[]).map((p) => p.id) : [];
}

function short(id: string | undefined) {
  return id ? id.slice(0, 11) : '(없음)';
}

/** setDocumentData로 넣은 블록 ID를 에디터가 그대로 유지하는지 확인한다. */
function IdCheckSection() {
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [original, setOriginal] = useState<SeDocumentData | null>(null);

  const say = (line: string) => setLog((prev) => [...prev, line]);

  const checkDuplicates = async () => {
    setError(null);
    setLog([]);
    try {
      const doc = await readDocument();
      const dups = duplicateIds(doc);
      say(`블록 ${doc.document.components.length}개 · 중복 ID ${dups.length}개`);
      for (const id of dups) {
        const types = doc.document.components.filter((c) => c.id === id).map((c) => c['@ctype']);
        say(`  중복: ${short(id)} (${types.join(', ')})`);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const run = async () => {
    setError(null);
    setLog([]);
    setBusy(true);
    try {
      const before = await readDocument();
      const comps = before.document.components;
      const ti = comps.findIndex((c) => c['@ctype'] === 'text' && blockText(c).trim());
      if (ti < 0) throw new Error('내용이 있는 텍스트 블록이 하나 이상 필요합니다.');
      setOriginal(before);
      say(`1. 읽기: 블록 ${comps.length}개, 중복 ID ${duplicateIds(before).length}개`);

      const lines = blockText(comps[ti]).split('\n');
      lines[lines.length - 1] += ' [ID검사]';
      const refs = new BlockRefs();
      refs.sync(before);
      const target = refs.refOf(comps[ti].id);
      const { document: draft } = applyBatch(
        before,
        [
          { op: 'replace_block', ref: target, paragraphs: lines },
          { op: 'insert_block', after: target, type: 'text', paragraphs: ['[ID검사] 새 블록'] },
        ],
        refs,
      );
      const draftComps = draft.document.components;
      const editedId = draftComps[ti].id;
      const newId = draftComps[ti + 1].id;
      say(`2. 쓰기: [${ti}] 수정, 바로 뒤에 새 블록 추가 (새 ID ${short(newId)})`);
      await writeDocument(draft);
      await sleep(800);

      const after = await readDocument();
      const afterComps = after.document.components;
      const afterIds = new Set(afterComps.map((c) => c.id));
      const kept = draftComps.filter((c) => afterIds.has(c.id)).length;
      say(`3. 다시 읽기: 블록 ${afterComps.length}개 (넣은 것 ${draftComps.length}개)`);
      say(`   넣은 ID 중 유지 ${kept}/${draftComps.length}`);
      say(`   수정한 블록 ID: ${afterIds.has(editedId) ? '유지' : '바뀜'}`);
      say(`   새 블록 ID: ${afterIds.has(newId) ? '유지' : `바뀜 → ${short(afterComps[ti + 1]?.id)}`}`);
      const sameOrder = draftComps.every((c, i) => afterComps[i]?.id === c.id);
      say(`   순서까지 동일: ${sameOrder ? '예' : '아니오'}`);
      const draftP = paragraphIds(draftComps[ti]);
      const afterP = paragraphIds(afterComps.find((c) => c.id === editedId));
      const keptP = draftP.filter((id) => afterP.includes(id)).length;
      say(`   수정한 블록의 문단 ID 유지 ${keptP}/${draftP.length}`);
      say(`   중복 ID ${duplicateIds(after).length}개`);
      say('4. 확인이 끝나면 "원래대로 되돌리기"를 눌러 주세요.');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!original) return;
    setError(null);
    setBusy(true);
    try {
      await writeDocument(original);
      await sleep(800);
      const back = await readDocument();
      const same =
        back.document.components.length === original.document.components.length &&
        back.document.components.every((c, i) => c.id === original.document.components[i].id);
      say(`되돌림: 원래 ID와 ${same ? '모두 같음' : '다름'}`);
      setOriginal(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>7. 블록 ID 유지 검사</h2>
      <p className="muted">
        임시 글에서 해주세요. 텍스트 블록 하나 끝에 " [ID검사]"를 붙이고 새 블록 하나를 넣은 뒤, 에디터가 ID를 그대로 두는지 봅니다.
        복사·붙여넣기 중복은 에디터에서 블록을 복사해 붙여 넣은 뒤 "중복 ID만 검사"로 확인합니다.
      </p>
      <div className="row">
        <button onClick={run} disabled={busy}>검사 실행</button>
        <button onClick={restore} disabled={busy || !original}>원래대로 되돌리기</button>
        <button onClick={checkDuplicates} disabled={busy}>중복 ID만 검사</button>
      </div>
      {error && <p className="error">{error}</p>}
      {log.length > 0 && <pre>{log.join('\n')}</pre>}
    </section>
  );
}

function ProbeSection() {
  const [probe, setProbe] = useState<EditorProbe | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    try {
      setProbe(await sendToEditor<EditorProbe>({ type: 'probe' }));
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <section>
      <h2>1. 에디터 구조 분석</h2>
      <div className="row">
        <button onClick={run}>분석</button>
        {probe && (
          <button onClick={() => downloadJson('editor-probe.json', probe)}>
            JSON 저장
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {probe && (
        <>
          <p className="muted">
            제목: {probe.title ?? '(없음)'} · 컴포넌트 {probe.components.length}개 ·
            편집 가능 요소 {probe.editables.length}개 · 페이지 전역 변수{' '}
            {probe.pageGlobals.length}개
          </p>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>타입</th>
                <th>내용</th>
              </tr>
            </thead>
            <tbody>
              {probe.components.map((c) => (
                <tr key={c.index}>
                  <td>{c.index}</td>
                  <td>{c.type}</td>
                  <td>{c.textPreview}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <details>
            <summary>페이지 전역 변수 (에디터 인스턴스 후보)</summary>
            <pre>
              {probe.pageGlobals.map((g) => `${g.name}: ${g.type}`).join('\n')}
            </pre>
          </details>
        </>
      )}
    </section>
  );
}

function ExploreSection() {
  const [path, setPath] = useState('SmartEditor');
  const [result, setResult] = useState<ExploreResult | null>(null);
  const [docData, setDocData] = useState<DocumentDataResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const explore = async (target: string) => {
    setError(null);
    setPath(target);
    try {
      setResult(await sendToEditor<ExploreResult>({ type: 'explore', path: target }));
    } catch (e) {
      setError(String(e));
    }
  };

  const fetchDocumentData = async () => {
    setError(null);
    setDocData(null);
    try {
      setDocData(await sendToEditor<DocumentDataResult>({ type: 'document-data' }));
    } catch (e) {
      setError(String(e));
    }
  };

  const parent = path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : null;
  const canDrill = (type: string) => type === 'object' || type === 'function' || type === 'array';

  return (
    <section>
      <h2>4. 에디터 객체 탐색</h2>
      <div className="row">
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && explore(path)}
          style={{ flex: 1 }}
        />
        <button onClick={() => explore(path)}>탐색</button>
        {parent && <button onClick={() => explore(parent)}>↑ 상위</button>}
      </div>
      <div className="row">
        <button onClick={fetchDocumentData}>문서 데이터 가져오기</button>
        {docData && (
          <button onClick={() => downloadJson('document-data.json', docData)}>JSON 저장</button>
        )}
        {result && (
          <button onClick={() => downloadJson('explore.json', result)}>탐색 결과 저장</button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {docData && (
        <>
          <p className="muted">
            에디터 키: {docData.editorKeys.join(', ') || '(없음)'} · 사용: {docData.editorKey ?? '(getDocumentData 없음)'}
          </p>
          <pre>{JSON.stringify(docData.data, null, 2)?.slice(0, 5000)}</pre>
        </>
      )}
      {result && (
        <>
          <p className="muted">
            {result.path} : {result.type} {result.detail} · 항목 {result.entries.length}개
          </p>
          <table>
            <tbody>
              {result.entries.map((e) => (
                <tr key={e.name}>
                  <td>
                    {canDrill(e.type) ? (
                      <a href="#" onClick={(ev) => { ev.preventDefault(); explore(`${path}.${e.name}`); }}>
                        {e.name}
                      </a>
                    ) : (
                      e.name
                    )}
                  </td>
                  <td>{e.type}</td>
                  <td className={e.inherited ? 'muted' : undefined}>{e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function WriteTestSection() {
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (type: 'write-test' | 'write-restore') => {
    setError(null);
    setResult(null);
    try {
      const res = await sendToEditor<WriteTestResult | { restored: boolean }>({ type });
      setResult(JSON.stringify(res, null, 2));
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <section>
      <h2>5. 쓰기 테스트 (setDocumentData)</h2>
      <p className="muted">
        새 글(임시 글)에서만 해주세요. 마지막 텍스트 블록 끝에 테스트 문단을 한 줄 추가합니다.
      </p>
      <div className="row">
        <button onClick={() => run('write-test')}>테스트 문단 추가</button>
        <button onClick={() => run('write-restore')}>되돌리기</button>
      </div>
      {error && <p className="error">{error}</p>}
      {result && <pre>{result}</pre>}
    </section>
  );
}

function makeTestImage(): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 160;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#ff7043';
  g.fillRect(0, 0, 320, 160);
  g.fillStyle = '#fff';
  g.font = 'bold 26px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('blsee', 160, 65);
  g.font = '18px sans-serif';
  g.fillText(new Date().toLocaleTimeString(), 160, 105);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

function ImageInsertSection() {
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toClipboard = async () => {
    setError(null);
    setResult(null);
    try {
      const blob = await makeTestImage();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setResult('클립보드에 이미지 파일만 넣었습니다. 에디터에서 원하는 위치를 클릭하고 ⌘V 해보세요.');
    } catch (e) {
      setError(String(e));
    }
  };

  const syntheticPaste = async () => {
    setError(null);
    setResult('붙여넣기 이벤트를 보내는 중… (최대 6초)');
    try {
      const dataUrl = await blobToDataUrl(await makeTestImage());
      const attempts = await sendToEditor<ImagePasteAttempt[]>({ type: 'image-paste-test', dataUrl });
      setResult(JSON.stringify(attempts, null, 2));
    } catch (e) {
      setResult(null);
      setError(String(e));
    }
  };

  return (
    <section>
      <h2>6. 새 이미지 넣기 테스트</h2>
      <p className="muted">
        테스트용 주황색 이미지(시각 표시)를 만들어서 넣어봅니다. 먼저 에디터 본문에서 넣을 위치를 클릭해 두세요.
      </p>
      <div className="row">
        <button onClick={toClipboard}>A. 클립보드에 넣기 (직접 ⌘V)</button>
        <button onClick={syntheticPaste}>B. 붙여넣기 이벤트로 자동 삽입</button>
      </div>
      {error && <p className="error">{error}</p>}
      {result && <pre>{result}</pre>}
    </section>
  );
}

interface DumpEntry extends ClipboardDump {
  source?: FrameTarget;
}

function ClipboardSection() {
  const [dumps, setDumps] = useState<DumpEntry[]>([]);
  const [keyLog, setKeyLog] = useState<string[]>([]);
  const [testResult, setTestResult] = useState<PasteTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const listener = (msg: BroadcastMessage, sender: Browser.runtime.MessageSender) => {
      const source =
        sender.tab?.id !== undefined && sender.frameId !== undefined
          ? { tabId: sender.tab.id, frameId: sender.frameId }
          : undefined;
      if (msg?.type === 'clipboard-dump') {
        setDumps((prev) => [{ ...msg.dump, source }, ...prev].slice(0, 20));
      } else if (msg?.type === 'paste-key') {
        setKeyLog((prev) =>
          [`${msg.at.slice(11, 19)} ⌘V 키 감지 · ${msg.frameUrl.slice(0, 80)}`, ...prev].slice(0, 5),
        );
      }
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);

  const runPasteTest = async () => {
    setError(null);
    setTestResult(null);
    const last = dumps.find((d) => d.event === 'paste' && d.isTrusted && d.source);
    if (!last) {
      setError('아직 붙여넣기 기록이 없습니다. 위 순서의 3번(⌘V 붙여넣기)을 먼저 해주세요.');
      return;
    }
    try {
      setTestResult(
        await sendToEditor<PasteTestResult>({ type: 'paste-test', data: last.data }, last.source),
      );
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <section>
      <h2>2. 클립보드 왕복 테스트</h2>
      <ol className="muted">
        <li>본문에 글을 몇 줄 쓴다 (표가 있으면 더 좋음)</li>
        <li>본문 클릭 → ⌘A (전체 선택) → ⌘C (복사)</li>
        <li>본문 맨 끝 클릭 → ⌘V (붙여넣기) → 아래에 "paste" 기록이 생기는지 확인</li>
        <li>본문 맨 끝을 다시 클릭 → "가짜 붙여넣기 테스트" → 글이 한 번 더 붙는지 확인</li>
      </ol>
      {keyLog.length > 0 && <pre>{keyLog.join('\n')}</pre>}
      <div className="row">
        <button onClick={runPasteTest}>가짜 붙여넣기 테스트</button>
        {dumps.length > 0 && (
          <>
            <button onClick={() => downloadJson('clipboard-dumps.json', dumps)}>
              JSON 저장
            </button>
            <button onClick={() => setDumps([])}>비우기</button>
          </>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {testResult && <pre>{JSON.stringify(testResult, null, 2)}</pre>}
      {dumps.map((d, i) => (
        <div key={i} className="dump">
          <strong>
            {d.event} {d.isTrusted ? '' : '(합성)'}
          </strong>{' '}
          <span className="muted">
            {d.at} · 파일 {d.files}개 · {d.frameUrl.slice(0, 80)}
          </span>
          {Object.entries(d.data).map(([type, value]) => (
            <details key={type}>
              <summary>
                {type} ({value.length.toLocaleString()}자)
              </summary>
              <pre>{value.slice(0, 3000)}</pre>
            </details>
          ))}
        </div>
      ))}
    </section>
  );
}

function ServerSection({ onServerChanged }: { onServerChanged: () => void }) {
  const [health, setHealth] = useState<HealthResponse | 'down' | null>(null);
  const [conn, setConn] = useState<Connection | null>(null);
  const [error, setError] = useState('');

  const check = () => {
    setHealth(null);
    connection().then(setConn);
    checkHealth().then(
      (h) => {
        setHealth(h);
        setError('');
      },
      (e) => {
        setHealth('down');
        setError(e instanceof Error ? e.message : String(e));
      },
    );
  };
  useEffect(check, []);

  const pick = async (server: ServerChoice) => {
    await saveSettings({ server });
    check();
    onServerChanged();
  };

  return (
    <section>
      <h2>서버</h2>
      <div className="setting-row">
        <div className="setting-label">붙을 서버</div>
        <div className="segmented">
          {(['local', 'prod'] as const).map((s) => (
            <button key={s} className={conn?.server === s ? 'on' : ''} disabled={!conn} onClick={() => pick(s)}>
              {SERVERS[s].label}
            </button>
          ))}
        </div>
      </div>
      <div className="setting-row">
        <div>
          <div className="setting-label">
            {health === null ? (
              '확인 중…'
            ) : health === 'down' ? (
              <>
                <Dot kind="warn" /> 연결 안 됨
              </>
            ) : (
              <>
                <Dot kind="on" /> 연결됨
              </>
            )}
          </div>
          <div className="setting-sub">
            {conn ? conn.url || '주소 없음 (.env 의 WXT_API_BASE_URL)' : '…'}
            {health && health !== 'down' && !health.hasApiKey && ' · API 키 없음 (apps/server/.env 확인)'}
          </div>
          {error && <div className="setting-sub error">{error}</div>}
        </div>
        <button onClick={check}>다시 확인</button>
      </div>
    </section>
  );
}
