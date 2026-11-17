/** 설치 페이지. 외부 파일 없이 이 페이지 하나로 돈다. 키는 탭을 닫으면 지워지는 sessionStorage에 둔다. */
export const INSTALL_PAGE = /* html */ `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>블씨 설치</title>
<style>
  :root { --accent: #03c75a; --line: #e5e7eb; --text-2: #6b7280; --danger: #e03131; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.6 -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', sans-serif; color: #111; background: #f7f7f8; }
  main { max-width: 640px; margin: 0 auto; padding: 40px 16px 64px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  .lead { color: var(--text-2); margin: 0 0 24px; }
  .card { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  .card h2 { font-size: 16px; margin: 0 0 12px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  input { font: inherit; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; outline: none; flex: 1; min-width: 200px; }
  input:focus { border-color: var(--accent); }
  button { font: inherit; padding: 8px 14px; border: 1px solid #d1d5db; border-radius: 8px; background: #fff; cursor: pointer; }
  button:hover:not(:disabled) { background: #f3f4f6; }
  button:disabled { opacity: .5; cursor: default; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  button.primary:hover:not(:disabled) { background: #02b351; }
  button.small { padding: 3px 9px; font-size: 13px; }
  .err { color: var(--danger); margin-top: 8px; }
  .sub { color: var(--text-2); font-size: 13px; }
  ol { margin: 0; padding-left: 20px; }
  li { margin-bottom: 10px; }
  li:last-child { margin-bottom: 0; }
  code { font: 13px ui-monospace, Menlo, monospace; background: #f3f4f6; padding: 2px 6px; border-radius: 4px; }
  .top { display: flex; align-items: baseline; gap: 8px; }
  .top button { margin-left: auto; }
  .note { white-space: pre-wrap; background: #f7f7f8; border-radius: 8px; padding: 10px 12px; font-size: 14px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <h1>블씨 설치</h1>
  <p class="lead">네이버 블로그 글쓰기 도우미</p>

  <section id="login" class="card" hidden>
    <h2>접근 키</h2>
    <p class="sub" style="margin-top:0">받은 키를 넣으면 설치 파일과 안내가 보여요.</p>
    <form class="row" id="login-form">
      <input id="key" type="password" placeholder="blsee_…" autocomplete="off" />
      <button class="primary" id="enter">확인</button>
    </form>
    <div id="login-err" class="err" hidden></div>
  </section>

  <section id="app" hidden>
    <div class="card">
      <div class="top">
        <h2 id="hello" style="margin:0"></h2>
        <button id="logout" class="small">나가기</button>
      </div>
      <p id="release" class="sub"></p>
      <p id="note" class="note" hidden></p>
      <button class="primary" id="download">설치 파일 받기</button>
      <div id="dl-err" class="err" hidden></div>
    </div>

    <div class="card">
      <h2>처음 설치</h2>
      <ol>
        <li>위에서 받은 zip 파일의 압축을 풉니다. 풀린 폴더는 <b>지우지 않을 곳</b>(예: 문서 폴더)에 둡니다. 폴더를 지우면 확장도 사라집니다.</li>
        <li>크롬 주소창에 <code>chrome://extensions</code> 를 입력해 엽니다.</li>
        <li>오른쪽 위 <b>개발자 모드</b>를 켭니다.</li>
        <li><b>압축해제된 확장 프로그램을 로드합니다</b>를 누르고, 1번에서 푼 폴더를 고릅니다.</li>
        <li>주소창 옆 퍼즐 아이콘을 눌러 <b>블씨</b>를 고정합니다.</li>
        <li>네이버 블로그 글쓰기 화면에서 블씨 아이콘을 누르면 오른쪽에 패널이 열립니다.</li>
        <li>패널 오른쪽 위 사람 아이콘(계정)에서 이 페이지에 넣은 <b>같은 키</b>를 넣고 저장합니다.
          <button class="small" id="copy-key">키 복사</button></li>
      </ol>
    </div>

    <div class="card">
      <h2>새 버전으로 바꾸기</h2>
      <ol>
        <li>위에서 새 설치 파일을 받아 압축을 풉니다.</li>
        <li>처음 설치한 폴더의 내용을 새로 푼 파일로 <b>덮어씁니다</b>. (폴더 위치는 그대로 둡니다)</li>
        <li><code>chrome://extensions</code> 에서 블씨 카드의 새로고침 버튼을 누릅니다.</li>
      </ol>
      <p class="sub">대화 기록과 키는 그대로 남아요.</p>
    </div>

    <div class="card">
      <h2>참고</h2>
      <ol>
        <li>크롬을 켤 때 "개발자 모드 확장 프로그램 사용 중지" 안내가 나오면 그냥 닫으면 됩니다.</li>
        <li>키는 다른 사람과 나눠 쓰지 마세요. 장작이 함께 줄어듭니다.</li>
      </ol>
    </div>
  </section>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const STORE = 'blsee-install-key';
  let key = sessionStorage.getItem(STORE) || '';

  async function api(path) {
    const res = await fetch('/install/api' + path, { headers: { 'x-blsee-key': key } });
    if (res.status === 401) { logout(); throw new Error((await res.json()).error); }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '오류 ' + res.status);
    return res;
  }

  const mb = (n) => (n / 1024 / 1024).toFixed(1) + 'MB';
  const when = (iso) => new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });

  async function enter() {
    const info = await (await api('/info')).json();
    sessionStorage.setItem(STORE, key);
    $('hello').textContent = info.name + ' 님, 반가워요';
    const r = info.release;
    $('release').textContent = r ? '버전 ' + r.version + ' · ' + mb(r.size) + ' · ' + when(r.updatedAt) + ' 올림' : '아직 올린 설치 파일이 없어요.';
    $('note').textContent = r && r.note ? r.note : '';
    $('note').hidden = !(r && r.note);
    $('download').disabled = !r;
    $('login').hidden = true;
    $('app').hidden = false;
  }

  function logout() {
    key = '';
    sessionStorage.removeItem(STORE);
    $('app').hidden = true;
    $('login').hidden = false;
    $('key').focus();
  }

  $('login-form').onsubmit = async (e) => {
    e.preventDefault();
    key = $('key').value.trim();
    if (!key) return;
    $('enter').disabled = true;
    $('login-err').hidden = true;
    try {
      await enter();
      $('key').value = '';
    } catch (err) {
      $('login-err').textContent = err.message;
      $('login-err').hidden = false;
    } finally {
      $('enter').disabled = false;
    }
  };

  $('download').onclick = async () => {
    $('download').disabled = true;
    $('dl-err').hidden = true;
    try {
      const res = await api('/download');
      const name = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'blsee.zip';
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      $('dl-err').textContent = err.message;
      $('dl-err').hidden = false;
    } finally {
      $('download').disabled = false;
    }
  };

  $('copy-key').onclick = async () => {
    await navigator.clipboard.writeText(key);
    $('copy-key').textContent = '복사했어요';
    setTimeout(() => ($('copy-key').textContent = '키 복사'), 1500);
  };

  $('logout').onclick = logout;

  if (key) enter().catch(logout); else logout();
})();
</script>
</body>
</html>
`;
