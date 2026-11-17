/** 개인정보처리방침 (/privacy). 스토어 등록에 쓰는 공개 페이지라 키 없이 보인다. 연락처는 저장소에 두지 않고 PRIVACY_CONTACT에서 읽는다. */
const UPDATED = '2026년 11월 3일';

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function privacyPage(contact = process.env.PRIVACY_CONTACT?.trim()): string {
  const contactLine = contact
    ? `<p>개인정보 처리에 관한 문의, 열람·삭제 요청은 <a href="mailto:${escape(contact)}">${escape(contact)}</a> 으로 보내 주세요.</p>`
    : '<p>개인정보 처리에 관한 문의, 열람·삭제 요청은 접근 키를 받은 운영자에게 연락해 주세요.</p>';

  return /* html */ `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>블씨 개인정보처리방침</title>
<style>
  body { margin: 0; font: 15px/1.7 -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', sans-serif; color: #111; background: #f7f7f8; }
  main { max-width: 720px; margin: 0 auto; padding: 40px 16px 64px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 32px 0 8px; }
  .sub { color: #6b7280; font-size: 13px; margin: 0 0 24px; }
  ul { padding-left: 20px; }
  li { margin-bottom: 6px; }
  a { color: #02a24b; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; background: #fff; }
  th, td { border: 1px solid #e5e7eb; padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background: #f3f4f6; font-weight: 600; }
</style>
</head>
<body>
<main>
  <h1>블씨 개인정보처리방침</h1>
  <p class="sub">시행일: ${UPDATED}</p>

  <p>블씨(blsee)는 네이버 블로그 글쓰기 화면에서 AI로 글 편집, 이미지 만들기, 자료 검색을 돕는 Chrome 확장 프로그램입니다.
  이 문서는 블씨가 어떤 정보를 어디서 처리하고, 무엇을 보관하는지 설명합니다.</p>

  <h2>1. 한눈에 보기</h2>
  <ul>
    <li>글 내용은 사용자가 블씨에 요청을 보낼 때만 블씨 서버로 전송되며, 서버는 요청을 처리한 뒤 글 내용을 저장하지 않습니다.</li>
    <li>대화 기록, 설정, 내 블로그 글 목록은 사용자의 브라우저(또는 사용자가 고른 PC의 폴더)에만 저장됩니다.</li>
    <li>네이버 로그인 정보(쿠키)는 브라우저 밖으로 나가지 않습니다.</li>
    <li>광고, 사용자 추적, 정보 판매를 하지 않습니다.</li>
  </ul>

  <h2>2. 사용자의 브라우저 안에서만 처리하는 정보</h2>
  <ul>
    <li><b>글쓰기 화면의 내용</b>: 지금 쓰고 있는 글의 문단, 표, 이미지 등을 읽어 사이드 패널에 보여 주고, 편집 결과를 에디터에 반영합니다.</li>
    <li><b>내 블로그 글 목록</b>: 카테고리와 글 제목·날짜·공개 범위를 네이버에서 직접 불러와 탐색 화면에 보여 줍니다. 이 요청은 브라우저에서 네이버로 바로 가며 블씨 서버를 거치지 않습니다.</li>
    <li><b>저장 위치</b>: 대화 기록, 설정, 접근 키, 글 목록, 오늘 사용량은 Chrome 확장 저장소(chrome.storage)에 저장됩니다.
      사용자가 작업공간 폴더를 연결하면 대화 기록과 이미지, 검색 자료는 그 폴더에 저장됩니다.</li>
  </ul>

  <h2>3. 블씨 서버로 보내는 정보</h2>
  <p>사용자가 요청을 보내거나 빠른 실행 메뉴를 누를 때만 아래 정보가 블씨 서버로 전송됩니다(HTTPS).</p>
  <ul>
    <li>요청 문장과 그 대화의 이전 내용</li>
    <li>요청을 처리하는 데 필요한 글 내용(문단, 표, 제목 등)과 가리킨 위치</li>
    <li>요청에 필요한 이미지(글 안의 이미지, 사용자가 첨부한 이미지)</li>
    <li>요청 시각</li>
    <li>접근 키(사용 권한 확인과 사용량 계산용)</li>
  </ul>
  <p>서버는 요청을 처리하는 동안에만 이 정보를 메모리에 두고, 처리가 끝나면 버립니다. 글 내용, 이미지, 대화 내용을 디스크나 데이터베이스에 저장하지 않습니다.</p>

  <h2>4. 서버가 보관하는 정보</h2>
  <table>
    <tr><th>항목</th><th>내용</th><th>보관</th></tr>
    <tr><td>접근 키 정보</td><td>운영자가 키를 발급할 때 붙인 이름, 지급한 사용량(장작), 쓴 사용량, 발급 시각, 마지막 사용 시각</td><td>키를 삭제할 때까지</td></tr>
    <tr><td>서버 운영 기록</td><td>요청마다 키 이름, 사용한 AI 모델과 사용량·비용 요약, 설치 파일 다운로드 기록. 글 내용과 이미지는 남기지 않습니다.</td><td>서버 로그 용량이 차면 오래된 것부터 자동 삭제</td></tr>
  </table>

  <h2>5. 외부 서비스에 맡기는 처리</h2>
  <p>블씨 서버는 요청을 처리하기 위해 아래 서비스의 API를 사용합니다. 전송되는 정보는 해당 요청 처리에 필요한 범위로 한정됩니다.</p>
  <table>
    <tr><th>서비스</th><th>용도</th><th>전송되는 정보</th></tr>
    <tr><td>Google (Gemini API)</td><td>글 이해·편집, 이미지 설명, 이미지 생성·편집</td><td>요청 문장, 대화 내용, 관련 글 내용과 이미지</td></tr>
    <tr><td>Perplexity (API)</td><td>웹 자료 검색, 이미지 검색</td><td>AI가 요청을 바탕으로 만든 검색어</td></tr>
  </table>
  <p>각 서비스의 데이터 처리는 해당 회사의 약관과 개인정보처리방침을 따릅니다:
    <a href="https://ai.google.dev/gemini-api/terms" rel="noopener">Gemini API 약관</a>,
    <a href="https://policies.google.com/privacy" rel="noopener">Google 개인정보처리방침</a>,
    <a href="https://www.perplexity.ai/hub/legal/privacy-policy" rel="noopener">Perplexity 개인정보처리방침</a>.</p>
  <p>이미지 검색 결과를 가져올 때는 블씨 서버가 해당 웹사이트에서 이미지를 내려받습니다. 이때 그 사이트에는 사용자가 아니라 서버의 정보가 전달됩니다.</p>

  <h2>6. 확장 프로그램 권한</h2>
  <ul>
    <li><b>sidePanel</b>: 블로그 에디터 옆에 블씨 화면을 띄웁니다.</li>
    <li><b>storage</b>: 대화 기록, 설정, 접근 키, 글 목록을 브라우저에 저장합니다.</li>
    <li><b>blog.naver.com</b>: 글쓰기 화면을 읽고 편집 결과를 반영하며, 내 블로그 글 목록을 불러옵니다.</li>
    <li><b>pstatic.net</b>: 글 안의 이미지를 불러옵니다(네이버 이미지 서버).</li>
    <li><b>블씨 서버</b>: AI 처리를 요청합니다.</li>
  </ul>

  <h2>7. 사용자의 선택과 삭제</h2>
  <ul>
    <li>대화 기록은 사이드 패널의 대화 기록에서 하나씩, 또는 계정 화면에서 모두 지울 수 있습니다.</li>
    <li>확장 프로그램을 삭제하면 브라우저에 저장된 블씨 데이터가 함께 지워집니다. 작업공간 폴더의 파일은 사용자가 직접 지울 수 있습니다.</li>
    <li>접근 키 정보 삭제는 아래 연락처로 요청할 수 있습니다.</li>
  </ul>

  <h2>8. 문의</h2>
  ${contactLine}

  <h2>9. 변경</h2>
  <p>이 방침이 바뀌면 이 페이지에 새 시행일과 함께 알립니다.</p>
</main>
</body>
</html>`;
}
