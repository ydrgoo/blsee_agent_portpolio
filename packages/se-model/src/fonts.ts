/**
 * 스마트에디터 ONE 글꼴/글자 크기 메뉴. 글자 노드 style의 fontFamily, fontSizeCode 값으로 저장된다.
 * system, nanumbarungothic 외의 코드는 에디터 화면의 se-ff-* 클래스 이름에서 가져온 것이다.
 *
 * 인포그래픽 HTML은 font-family에 family(또는 name)를 쓰고, 렌더러가 번들/워크스페이스 파일을 @font-face로 붙인다.
 */
export const FONTS = [
  { name: '기본서체', code: 'system', family: 'sans-serif', css: `'Apple SD Gothic Neo','Malgun Gothic',sans-serif` },
  { name: '나눔고딕', code: 'nanumgothic', family: 'Nanum Gothic', css: `'Nanum Gothic','NanumGothic',sans-serif` },
  { name: '나눔명조', code: 'nanummyeongjo', family: 'Nanum Myeongjo', css: `'Nanum Myeongjo','NanumMyeongjo','AppleMyungjo',serif` },
  { name: '나눔바른고딕', code: 'nanumbarungothic', family: 'NanumBarunGothic', css: `'NanumBarunGothic','Nanum Gothic',sans-serif` },
  { name: '나눔스퀘어', code: 'nanumsquare', family: 'NanumSquare', css: `'NanumSquare','Nanum Gothic',sans-serif` },
  { name: '마루부리', code: 'nanummaruburi', family: 'MaruBuri', css: `'MaruBuri','Maru Buri','Nanum Myeongjo',serif` },
  { name: '다시시작해', code: 'nanumdasisijaghae', family: 'NanumDaSiSiJagHae', css: `'NanumDaSiSiJagHae',cursive` },
  { name: '바른히피', code: 'nanumbareunhipi', family: 'NanumBaReunHiPi', css: `'NanumBaReunHiPi',cursive` },
  { name: '우리딸손글씨', code: 'nanumuriddalsongeulssi', family: 'NanumURiDdarSonGeurSsi', css: `'NanumURiDdarSonGeurSsi',cursive` },
] as const;

/** 확장에 번들로 넣는 글꼴 파일 (apps/extension/assets/fonts/). 기본서체는 없음. */
export const BUNDLE_FONT_FILES: { name: string; family: string; weights: Partial<Record<400 | 700, string>> }[] = [
  { name: '나눔고딕', family: 'Nanum Gothic', weights: { 400: 'NanumGothic-Regular.woff2', 700: 'NanumGothic-Bold.woff2' } },
  { name: '나눔명조', family: 'Nanum Myeongjo', weights: { 400: 'NanumMyeongjo-Regular.woff2', 700: 'NanumMyeongjo-Bold.woff2' } },
  { name: '나눔바른고딕', family: 'NanumBarunGothic', weights: { 400: 'NanumBarunGothic-Regular.woff2', 700: 'NanumBarunGothic-Bold.woff2' } },
  { name: '나눔스퀘어', family: 'NanumSquare', weights: { 400: 'NanumSquare-Regular.woff2', 700: 'NanumSquare-Bold.woff2' } },
  { name: '마루부리', family: 'MaruBuri', weights: { 400: 'MaruBuri-Regular.woff2', 700: 'MaruBuri-Bold.woff2' } },
  { name: '다시시작해', family: 'NanumDaSiSiJagHae', weights: { 400: 'NanumDaSiSiJagHae-Regular.woff2' } },
  { name: '바른히피', family: 'NanumBaReunHiPi', weights: { 400: 'NanumBaReunHiPi-Regular.woff2' } },
  { name: '우리딸손글씨', family: 'NanumURiDdarSonGeurSsi', weights: { 400: 'NanumURiDdarSonGeurSsi-Regular.woff2' } },
];

export type FontName = (typeof FONTS)[number]['name'];

export const FONT_NAMES = FONTS.map((f) => f.name) as [FontName, ...FontName[]];

/** 글자 크기 메뉴 (px) */
export const FONT_SIZES = [11, 13, 15, 16, 19, 24, 28, 30, 34, 38] as const;

export function fontByName(name: string) {
  return FONTS.find((f) => f.name === name);
}

export function fontByCode(code: unknown) {
  return FONTS.find((f) => f.code === code);
}

/** 사람이 읽는 글꼴 이름. 모르는 코드는 그대로 */
export function fontLabel(code: unknown): string {
  return fontByCode(code)?.name ?? String(code);
}

export function fontSizeOf(code: unknown): number | undefined {
  const m = /^fs(\d+)$/.exec(String(code ?? ''));
  return m ? Number(m[1]) : undefined;
}
