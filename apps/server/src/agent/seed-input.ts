/**
 * 이미지·인포그래픽 담당이 받는 입력 메시지. 둘 다 같은 구조다.
 *
 *   [이미지] 또는 [인포그래픽]
 *   1. 지시 …
 *   고칠 점: …            (다음 회차에만)
 *
 *   [Original]            (고칠 때만)
 *   URI
 *   <원본 이미지>
 *
 *   [Result]              (평가할 때만)
 *   URI
 *   <결과 이미지>
 *
 *   [Context]
 *   맥락 …
 *
 *   [References]
 *   - URI — 역할
 *   <참조 이미지들>
 *
 * 원본과 참조 이미지는 픽셀을 함께 넣어, 모델이 도구를 부르지 않고 바로 본다.
 */
import { HumanMessage } from 'langchain';
import type { ImageInput } from '@blog-helper/shared';
import { REFERENCE_MAX_SIDE, keptImage, toImageUri, type CallDocTool } from './tools';

export interface SeedRef {
  uri: string;
  role: string;
}

export interface SeedInput {
  /** "이미지" 또는 "인포그래픽" */
  head: string;
  instructions: string[];
  /** 사용자가 이 그림에 대해 직접 적은 글 (구체화가 고른 메시지 원문) */
  requests?: string[];
  /** 앞 회차에서 남은 고칠 점 */
  issues?: string[];
  /** issues 목록의 이름 (기본 "고칠 점") */
  issuesLabel?: string;
  /** 고칠 이미지 URI. image가 없으면 불러온다 */
  original?: { uri: string; image?: ImageInput };
  /** 평가할 결과 이미지 URI (원본 크기로 넣는다) */
  result?: { uri: string; image?: ImageInput };
  /** [Context] 단락들 */
  context: string[];
  /** 원본 밖의 참조 이미지 */
  references: SeedRef[];
}

/** 픽셀까지 넣는 참조 이미지 수 (나머지는 URI만) */
const REFERENCE_IMAGES_MAX = 4;

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: string };

const imagePart = (image: ImageInput): Part => ({ type: 'image_url', image_url: `data:${image.mimeType};base64,${image.data}` });
const numbered = (lines: string[]) => lines.map((s, i) => `${i + 1}. ${s}`).join('\n');

/** 같은 이미지를 가리키는 참조는 하나만, 원본과 같은 것은 뺀다. */
export function uniqueRefs(refs: SeedRef[], original?: string): SeedRef[] {
  const key = (uri: string) => (uri.startsWith('blsee://') ? toImageUri(uri) : uri);
  const seen = new Set(original ? [key(original)] : []);
  return refs.filter((r) => {
    const k = key(r.uri);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 픽셀을 불러온다. maxSide가 있으면 긴 변을 줄인다 (참조). 원본은 그대로. */
async function load(call: CallDocTool, uri: string, maxSide?: number): Promise<ImageInput | undefined> {
  if (!uri.startsWith('blsee://')) return undefined;
  try {
    return (await keptImage(call, uri, maxSide)).image;
  } catch {
    return undefined;
  }
}

/** 입력 메시지와, 같은 내용의 글만 (평가·로그용) */
export async function seedMessage(call: CallDocTool, o: SeedInput): Promise<{ message: HumanMessage; text: string }> {
  const references = uniqueRefs(o.references, o.original?.uri);
  const full = (x?: { uri: string; image?: ImageInput }) =>
    x ? (x.image ? Promise.resolve(x.image) : load(call, x.uri)) : Promise.resolve(undefined);
  const [originalImage, resultImage, refImages] = await Promise.all([
    full(o.original),
    full(o.result),
    Promise.all(references.map((r, i) => (i < REFERENCE_IMAGES_MAX ? load(call, r.uri, REFERENCE_MAX_SIDE) : Promise.resolve(undefined)))),
  ]);

  const head = [`[${o.head}]\n${numbered(o.instructions)}`, o.issues?.length ? `${o.issuesLabel ?? '고칠 점'}:\n${numbered(o.issues)}` : '']
    .filter(Boolean)
    .join('\n\n');
  const requests = o.requests?.length ? `[참고: 사용자 원문]\n${o.requests.join('\n\n---\n\n')}` : '';
  const original = o.original ? `[Original]\n${o.original.uri}${originalImage ? '' : ' (픽셀을 불러오지 못했다)'}` : '';
  const result = o.result ? `[Result]\n${o.result.uri}${resultImage ? '' : ' (픽셀을 불러오지 못했다)'}` : '';
  const context = `[Context]\n${o.context.filter(Boolean).join('\n\n')}`;
  const refLines = references.map((r, i) => `- ${r.uri} — ${r.role}${refImages[i] ? ` (아래 [참조 ${i + 1}])` : ''}`);
  const refs = references.length ? `[References]\n${refLines.join('\n')}` : '';

  const parts: Part[] = [{ type: 'text', text: head }];
  if (requests) parts.push({ type: 'text', text: requests });
  if (original) {
    parts.push({ type: 'text', text: original });
    if (originalImage) parts.push(imagePart(originalImage));
  }
  if (result) {
    parts.push({ type: 'text', text: result });
    if (resultImage) parts.push(imagePart(resultImage));
  }
  parts.push({ type: 'text', text: context });
  if (refs) {
    parts.push({ type: 'text', text: refs });
    refImages.forEach((image, i) => {
      if (!image) return;
      parts.push({ type: 'text', text: `[참조 ${i + 1}] ${references[i].uri}` }, imagePart(image));
    });
  }
  const text = [head, requests, original, result, context, refs].filter(Boolean).join('\n\n');
  return { message: new HumanMessage({ content: parts }), text };
}
