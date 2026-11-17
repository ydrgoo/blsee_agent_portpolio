import type { SeComponent } from '@blog-helper/se-model';
import { readDocument, sendToEditor } from './editor-client';
import { blobToDataUrl } from './images';
import type { ImagePasteAttempt } from './messages';

const UPLOAD_TIMEOUT_MS = 30_000;
const POLL_MS = 100;
const SETTLE_MS = 1500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isUploaded(c: SeComponent): boolean {
  return c['@ctype'] === 'image' && typeof c.src === 'string' && /^https?:/.test(c.src);
}

/**
 * 이미지 파일을 에디터에 붙여넣기 이벤트로 넣어 네이버에 올리고, 올라간 이미지 컴포넌트를 돌려준다.
 * 지금 커서 자리에 들어가므로, 부르는 쪽이 문서를 다시 써서 자리를 맞춘다.
 */
export async function uploadImage(blob: Blob): Promise<SeComponent> {
  const before = new Set((await readDocument()).document.components.map((c) => c.id));
  const attempts = await sendToEditor<ImagePasteAttempt[]>({
    type: 'image-paste-test',
    dataUrl: await blobToDataUrl(blob),
  });

  // 주소가 생긴 뒤 에디터가 사진을 불러와 imageLoaded를 한 번 더 쓴다. 그 전에 문서를 쓰면 덮어써져 우리가 넣은 것이 사라진다.
  // imageLoaded가 안 오면 문서가 잠시 그대로일 때까지 기다린다.
  const deadline = Date.now() + UPLOAD_TIMEOUT_MS;
  let last = '';
  let stableSince = 0;
  while (Date.now() < deadline) {
    const doc = await readDocument();
    const added = doc.document.components.find((c) => !before.has(c.id) && isUploaded(c));
    if (added?.imageLoaded === true) return added;
    const snapshot = JSON.stringify(doc.document.components);
    if (snapshot !== last) {
      last = snapshot;
      stableSince = Date.now();
    } else if (added && Date.now() - stableSince >= SETTLE_MS) {
      return added;
    }
    await sleep(POLL_MS);
  }
  const tried = attempts.map((a) => `${a.where}: 처리 ${a.editorHandled ? '됨' : '안 됨'}`).join(', ');
  throw new Error(`이미지 업로드가 ${UPLOAD_TIMEOUT_MS / 1000}초 안에 끝나지 않았습니다 (${tried}).`);
}
