import { GoogleGenAI, type GenerateContentResponse } from '@google/genai';
import type {
  ImageDescribeRequest,
  ImageDescribeResponse,
  ImageEditRequest,
  ImageEditResponse,
  ImageInput,
  UsagePurpose,
  ViewImage,
} from '@blog-helper/shared';
import { config } from './config';
import type { UsageMeter } from './usage';

const IMAGE_MODEL = config['image-draw'].model;
const VISION_MODEL = config.view.model;

let client: GoogleGenAI | null = null;
export function genai(): GoogleGenAI {
  if (!process.env.GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY가 없습니다.');
  client ??= new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
  return client;
}

export function meterOf(res: GenerateContentResponse, meter: UsageMeter | undefined, model: string, purpose: UsagePurpose) {
  const u = res.usageMetadata;
  // 출력은 종류별로 단가가 다르다 (이미지 모델: 이미지 출력과 텍스트·생각 출력).
  const imageOutput =
    u?.candidatesTokensDetails?.filter((d) => d.modality === 'IMAGE').reduce((s, d) => s + (d.tokenCount ?? 0), 0) ?? 0;
  meter?.add(model, purpose, {
    input: u?.promptTokenCount ?? 0,
    cached: u?.cachedContentTokenCount ?? 0,
    output: Math.max(0, (u?.candidatesTokenCount ?? 0) - imageOutput) + (u?.thoughtsTokenCount ?? 0),
    imageOutput,
  });
}

function isImage(v: unknown): v is ImageInput {
  const o = v as ImageInput;
  return typeof o?.mimeType === 'string' && o.mimeType.startsWith('image/') && typeof o.data === 'string';
}

export function parseEditRequest(body: unknown): ImageEditRequest {
  const b = body as ImageEditRequest;
  if (!isImage(b?.image) || typeof b.instruction !== 'string' || !b.instruction.trim()) {
    throw new Error('image{mimeType,data}와 instruction이 필요합니다.');
  }
  return b;
}

export function parseDescribeRequest(body: unknown): ImageDescribeRequest {
  const b = body as ImageDescribeRequest;
  if (!Array.isArray(b?.images) || !b.images.length || !b.images.every(isImage) || typeof b.question !== 'string') {
    throw new Error('images[{mimeType,data}]와 question이 필요합니다.');
  }
  return b;
}

type ImagePart = { text: string } | { inlineData: ImageInput };

/** 텍스트도 허용하면 이미지 없이 "바꿨습니다"라고만 답하는 경우가 있어 이미지만 받는다. */
async function imageOnce(parts: ImagePart[], meter?: UsageMeter) {
  const res = await genai().models.generateContent({
    model: IMAGE_MODEL,
    contents: [{ role: 'user', parts }],
    config: { ...config['image-draw'].params, responseModalities: ['IMAGE'] },
  });
  meterOf(res, meter, IMAGE_MODEL, 'image_edit');

  let image: ImageInput | null = null;
  const texts: string[] = [];
  for (const part of res.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData?.data && !image) {
      image = { mimeType: part.inlineData.mimeType ?? 'image/png', data: part.inlineData.data };
    } else if (part.text) {
      texts.push(part.text);
    }
  }
  const reason = res.candidates?.[0]?.finishReason ?? res.promptFeedback?.blockReason ?? '없음';
  return { image, text: texts.join('\n'), reason };
}

async function imageWithRetry(parts: ImagePart[], meter?: UsageMeter): Promise<ImageEditResponse> {
  const notes: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await imageOnce(parts, meter);
    if (r.image) return { model: IMAGE_MODEL, image: r.image, text: [...notes, r.text].filter(Boolean).join('\n') };
    notes.push(`${attempt}차 시도: 이미지 없음 (finishReason: ${r.reason})${r.text ? ` - ${r.text}` : ''}`);
  }
  return { model: IMAGE_MODEL, image: null, text: notes.join('\n') };
}

/** 지시 한 줄로 편집한다 (개발자 도구의 이미지 편집 시험용). 에이전트는 editImageSpec을 쓴다. */
export function editImage(req: ImageEditRequest, meter?: UsageMeter): Promise<ImageEditResponse> {
  return imageWithRetry(
    [{ text: `다음 이미지를 편집해서 결과 이미지를 출력해. 지시: ${req.instruction}` }, { inlineData: req.image }],
    meter,
  );
}

export const DEFAULT_LOCALE = 'ko-KR';

/*
 * 에이전트용 이미지 만들기 (drawImage). 원본을 고치거나(지시한 것 외에는 그대로) 새로 그린다.
 * 지시는 칸(PIXEL_KINDS)별 항목 목록으로 받고, 프롬프트는 여기서 "지시사항:" 목록 모양으로 만든다.
 * ref는 함께 넘긴 참조 이미지의 번호(1부터)다.
 */
export interface ImageItem<K extends string> {
  kind: K;
  instruction: string;
  ref?: number;
}

const NO_MARKS = '워터마크, 로고, 서명, 테두리는 넣지 않는다. 참고로 준 이미지 속 워터마크·로고·글자는 옮기지 않는다.';
const NO_TEXT = '글자 항목에 적은 글자 외에는 새 글자를 넣지 않는다. 간판, 포스터, 화면처럼 글자가 있을 법한 곳은 비우거나 흐리게 둔다.';

const localeRule = (locale: string, scope: string) =>
  `요청자 언어·지역: ${locale}. ${scope}지시나 참고 이미지로 정해지지 않았으면 이 지역 기준으로 그린다: 사람은 이 지역 사람, ` +
  `간판·화폐·음식·생활 소품은 이 지역 모습. 그리는 장소가 지시로 정해졌으면 그 장소를 따른다. 그림에 넣는 글자는 이 언어로 쓴다.`;

const withRef = (item: ImageItem<string>, refName: string) =>
  item.ref ? `${item.instruction} ([${refName} ${item.ref}]의 생김새 그대로)` : item.instruction;

function imageParts(head: string, images: { label: string; image: ImageInput }[]): ImagePart[] {
  return [{ text: head }, ...images.flatMap((i) => [{ text: `[${i.label}]` }, { inlineData: i.image }])];
}

/** 이미지 명세의 칸. 새로 그릴 때와 고칠 때가 같은 칸을 쓴다 (고칠 때 동사는 지시 문장 안에 쓴다). */
export const PIXEL_KINDS = ['인물', '사물', '배경', '구도', '화풍', '글자', '뺄 것'] as const;
export type PixelKind = (typeof PIXEL_KINDS)[number];

export interface DrawImageSpec {
  /** generate: 새로 그린다 / edit: 원본에서 지시한 곳만 바꾼다 */
  mode: 'generate' | 'edit';
  items: ImageItem<PixelKind>[];
  /** 고칠 이미지. edit면 바탕, generate면 생김새·배치를 살릴 대상 */
  original?: ImageInput;
  /** 참조 이미지 (items의 ref가 가리킨다) */
  references?: ImageInput[];
  /** 사용자가 확인 카드에 적은 의견 */
  note?: string;
  /** 사용자가 이 그림에 대해 직접 적은 지시 원문 (추가 요청사항으로 함께 넣는다) */
  requests?: string[];
  locale?: string;
  /** true면 그림 안 글자·워터마크를 한 번 더 금지한다 (인포 배경 등) */
  noExtraText?: boolean;
}

/** 칸별 지시를 "지시사항:" 목록으로 */
function pixelLines(items: ImageItem<PixelKind>[]): string[] {
  return PIXEL_KINDS.flatMap((kind) => items.filter((i) => i.kind === kind).map((i) => `- ${kind}: ${withRef(i, '참조')}`));
}

/** 이미지 명세대로 새로 그리거나(generate) 원본을 고친다(edit). */
export function drawImage(spec: DrawImageSpec, meter?: UsageMeter): Promise<ImageEditResponse> {
  const references = spec.references ?? [];
  const edit = spec.mode === 'edit' && !!spec.original;
  const restyle = spec.items.some((i) => i.kind === '화풍');
  const keep = restyle
    ? '구도, 시점, 크기 비율, 대상의 배치·자세·표정, 사물의 위치와 개수'
    : '구도, 시점, 크기 비율, 인물의 얼굴·자세·옷, 배경, 색감, 조명, 질감, 원래 있던 글자';
  const lines = [
    edit ? '[원본] 이미지를 편집해서 결과 이미지 한 장을 출력해.' : '블로그 글에 넣을 새 이미지 한 장을 만들어 출력해.',
    edit ? '지시사항 (각 지시는 결과에서 눈으로 분명히 알아볼 만큼 바꾼다. 얼굴·표정의 작은 부분을 고치는 지시도 그 부분은 확실히 달라져야 한다):' : '지시사항:',
    ...pixelLines(spec.items),
    ...(spec.note ? [`사용자 의견: ${spec.note}`] : []),
    ...(spec.requests?.length ? [`참고 (사용자가 쓴 원래 요청. 지시사항과 다르면 지시사항을 따른다):\n${spec.requests.join('\n\n')}`] : []),
    ...(edit ? [`지시사항에 적은 부분 밖은 원본과 똑같이 둔다 (${keep} 가운데 지시하지 않은 것).`] : []),
    ...(!edit && spec.original
      ? ['[원본] 이미지는 다시 그릴 대상이다. 지시사항대로 새로 그리되, 원본의 대상·배치·특징은 알아볼 수 있게 살린다.']
      : []),
    ...(references.length
      ? [
          '[참조] 이미지는 지시사항에 적힌 대상의 생김새를 알려 주는 용도다. 대상은 알아볼 수 있게 모양, 색, 무늬, 얼굴을 살리고, ' +
            (edit ? '크기·원근·조명·그림자를 원본에 맞춰 자연스럽게 넣는다.' : '구도는 지시사항대로 새로 잡는다.'),
        ]
      : []),
    localeRule(spec.locale ?? DEFAULT_LOCALE, edit ? '새로 넣는 사람이나 글자는 ' : ''),
    ...(spec.noExtraText ? ['그림 안에 글자, 문구, 로고 텍스트, 워터마크를 넣지 않는다.'] : []),
    NO_TEXT,
    NO_MARKS,
  ];
  return imageWithRetry(
    imageParts(lines.join('\n'), [
      ...(spec.original ? [{ label: '원본', image: spec.original }] : []),
      ...references.map((image, i) => ({ label: `참조 ${i + 1}`, image })),
    ]),
    meter,
  );
}

export interface PromptGenerateSpec {
  /** 픽셀 모델에 그대로 넘길 생성 지시 */
  prompt: string;
  references?: ImageInput[];
  /** 참고 이미지 역할 라벨 (없으면 참고 1, 2…) */
  referenceLabels?: string[];
  locale?: string;
  /** true면 그림 안 글자·워터마크를 강하게 금지 (인포 배경 등) */
  noExtraText?: boolean;
}

/** prompt 본문을 그대로 넣어 새 이미지를 그린다. */
export function generateFromPrompt(spec: PromptGenerateSpec, meter?: UsageMeter): Promise<ImageEditResponse> {
  const references = spec.references ?? [];
  const labels = spec.referenceLabels;
  const lines = [
    '블로그 글에 넣을 새 이미지 한 장을 만들어 출력해.',
    spec.prompt.trim(),
    ...(references.length
      ? [
          '[참고] 이미지는 지시문에 적힌 대상의 생김새를 알려 주는 용도다. 대상은 알아볼 수 있게 모양, 색, 무늬, 얼굴을 살리되, ' +
            '참고 이미지를 그대로 복사하지 말고 지시문대로 새 구도로 그린다.',
        ]
      : []),
    localeRule(spec.locale ?? DEFAULT_LOCALE, ''),
    ...(spec.noExtraText
      ? ['그림 안에 글자, 문구, 로고 텍스트, 워터마크를 넣지 않는다.']
      : []),
    NO_MARKS,
  ];
  return imageWithRetry(
    imageParts(
      lines.join('\n'),
      references.map((image, i) => ({
        label: labels?.[i]?.trim() || `참고 ${i + 1}`,
        image,
      })),
    ),
    meter,
  );
}

export interface PromptEditSpec {
  base: ImageInput;
  /** 픽셀 모델에 그대로 넘길 수정 지시 */
  prompt: string;
  materials?: ImageInput[];
  materialLabels?: string[];
  locale?: string;
  noExtraText?: boolean;
}

/** 바탕 이미지를 prompt 지시대로 고친다. */
export function editFromPrompt(spec: PromptEditSpec, meter?: UsageMeter): Promise<ImageEditResponse> {
  const materials = spec.materials ?? [];
  const labels = spec.materialLabels;
  const lines = [
    '[바탕] 이미지를 편집해서 결과 이미지 한 장을 출력해.',
    spec.prompt.trim(),
    '지시와 무관한 구도·대상·배경은 원본과 같이 둔다.',
    ...(materials.length
      ? ['[재료] 이미지는 지시에 쓸 대상이다. 모양, 색, 무늬, 얼굴을 살리고 바탕에 맞춰 자연스럽게 넣는다.']
      : []),
    localeRule(spec.locale ?? DEFAULT_LOCALE, '새로 넣는 사람이나 글자는 '),
    ...(spec.noExtraText
      ? ['지시에서 글자를 넣으라고 하지 않으면 그림 안에 새 글자·워터마크를 넣지 않는다.']
      : []),
    NO_MARKS,
  ];
  return imageWithRetry(
    imageParts(lines.join('\n'), [
      { label: '바탕', image: spec.base },
      ...materials.map((image, i) => ({
        label: labels?.[i]?.trim() || `재료 ${i + 1}`,
        image,
      })),
    ]),
    meter,
  );
}

export async function describeImages(req: ImageDescribeRequest, meter?: UsageMeter): Promise<ImageDescribeResponse> {
  const res = await genai().models.generateContent({
    model: VISION_MODEL,
    contents: [
      {
        role: 'user',
        parts: [...req.images.map((inlineData) => ({ inlineData })), { text: req.question }],
      },
    ],
    config: { ...config.view.params },
  });
  meterOf(res, meter, VISION_MODEL, 'view');
  return { model: VISION_MODEL, text: res.text ?? '' };
}

const VIEW_INSTRUCTION = `아래 그림들은 작성 중인 블로그 글의 일부를 문서 데이터로 대략 그린 것이거나 글에 첨부된 이미지 원본이다.
그림마다 앞에 무엇을 그린 것인지 이름표가 있다. 질문에 답하는 데 필요한 것만, 그림 이름표별로 짧게 답한다.
그린 그림은 실제 에디터 화면의 근사치라 글꼴과 세부 간격은 다를 수 있다. 그런 차이는 지적하지 않는다.`;

/** view 도구: 이름표 붙은 그림들을 한 번에 보는 모델에 보내고, 질문에 대한 답 글만 돌려준다. */
export async function viewImages(images: ViewImage[], question: string, meter?: UsageMeter): Promise<string> {
  const parts = images.flatMap((img) => [
    { text: `[${img.label}]` },
    { inlineData: { mimeType: img.mimeType, data: img.data } },
  ]);
  const res = await genai().models.generateContent({
    model: VISION_MODEL,
    contents: [{ role: 'user', parts: [...parts, { text: `질문: ${question}` }] }],
    config: { ...config.view.params, systemInstruction: VIEW_INSTRUCTION },
  });
  meterOf(res, meter, VISION_MODEL, 'view');
  return res.text?.trim() || '(보는 모델이 답하지 않았습니다.)';
}
