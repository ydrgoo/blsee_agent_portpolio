/** 관리자 화면. 외부 파일 없이 이 페이지 하나로 돈다. 토큰은 탭을 닫으면 지워지는 sessionStorage에 둔다. */
export const ADMIN_PAGE = /* html */ `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>블씨 관리자</title>
<style>
  :root { --accent: #03c75a; --line: #e5e7eb; --text-2: #6b7280; --danger: #e03131; --warn: #f08c00; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', sans-serif; color: #111; background: #f7f7f8; }
  main { max-width: 880px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 20px; margin: 0 0 16px; display: flex; align-items: center; gap: 8px; }
  h1 button { margin-left: auto; }
  .card { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 16px; }
  .card h2 { font-size: 15px; margin: 0 0 12px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  input { font: inherit; padding: 7px 9px; border: 1px solid #d1d5db; border-radius: 8px; outline: none; }
  input:focus { border-color: var(--accent); }
  input.num { width: 90px; }
  button { font: inherit; padding: 6px 12px; border: 1px solid #d1d5db; border-radius: 8px; background: #fff; cursor: pointer; }
  button:hover:not(:disabled) { background: #f3f4f6; }
  button:disabled { opacity: .5; cursor: default; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  button.primary:hover:not(:disabled) { background: #02b351; }
  button.danger { color: var(--danger); }
  button.small { padding: 3px 8px; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: 12px; color: var(--text-2); font-weight: 500; }
  tr:last-child td { border-bottom: 0; }
  .name { font-weight: 600; }
  .sub { font-size: 12px; color: var(--text-2); }
  .bar { height: 6px; background: #eef0f2; border-radius: 3px; overflow: hidden; margin-top: 4px; width: 140px; }
  .bar > div { height: 100%; background: var(--accent); }
  .bar.low > div { background: var(--warn); }
  .bar.empty > div { background: var(--danger); }
  .tag { font-size: 11px; padding: 1px 6px; border-radius: 999px; background: #fdecec; color: var(--danger); margin-left: 6px; }
  .actions { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
  .msg { padding: 10px 12px; border-radius: 8px; margin-bottom: 16px; }
  .msg.err { background: #fdecec; color: var(--danger); }
  .msg.ok { background: #e8f8ef; }
  .msg code { font: 13px ui-monospace, Menlo, monospace; background: #fff; padding: 2px 6px; border-radius: 4px; word-break: break-all; user-select: all; }
  .empty { color: var(--text-2); padding: 12px 0; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <section id="login" class="card" hidden>
    <h2>관리자 토큰</h2>
    <form class="row" id="login-form">
      <input id="token" type="password" placeholder="ADMIN_TOKEN" autocomplete="current-password" style="flex:1;min-width:200px" />
      <button class="primary">들어가기</button>
    </form>
  </section>

  <section id="app" hidden>
    <h1>블씨 관리자 <button id="logout" class="small">나가기</button></h1>
    <div id="msg"></div>

    <div class="card">
      <h2>새 키 발급</h2>
      <form class="row" id="add-form">
        <input id="add-name" placeholder="이름 (예: 홍길동)" style="flex:1;min-width:160px" />
        <input id="add-wood" class="num" type="number" min="0" step="any" placeholder="장작" />
        <button class="primary">발급</button>
      </form>
    </div>

    <div class="card">
      <h2 id="list-title">키 목록</h2>
      <table>
        <thead><tr><th>이름</th><th>남은 장작</th><th>마지막 사용</th><th></th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
      <div id="empty" class="empty" hidden>발급한 키가 없습니다.</div>
    </div>

    <div class="card">
      <h2>설치 파일 올리기</h2>
      <p class="sub" style="margin-top:0">Mac에서 <code style="background:#f3f4f6">npm run zip:ext</code> 로 만든 <code style="background:#f3f4f6">apps/extension/.output/…-chrome.zip</code> 을 올립니다. 올리면 바로 설치 페이지에 나갑니다.</p>
      <form id="rel-form" style="display:flex;flex-direction:column;gap:8px">
        <div class="row">
          <input id="rel-file" type="file" accept=".zip" style="flex:1;min-width:200px" />
          <input id="rel-version" class="num" placeholder="1.2.3" style="width:100px" />
        </div>
        <textarea id="rel-note" rows="3" placeholder="바뀐 점 (설치 페이지에 보여요, 비워도 됨)" style="font:inherit;padding:7px 9px;border:1px solid #d1d5db;border-radius:8px;resize:vertical"></textarea>
        <div><button class="primary" id="rel-upload">올리기</button></div>
      </form>
    </div>

    <div class="card">
      <h2 id="rel-title">설치 파일 버전</h2>
      <table>
        <thead><tr><th>버전</th><th>올린 때</th><th>바뀐 점</th><th></th></tr></thead>
        <tbody id="rel-rows"></tbody>
      </table>
      <div id="rel-empty" class="empty" hidden>올린 설치 파일이 없습니다.</div>
    </div>
  </section>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const TOKEN = 'blsee-admin-token';
  let token = sessionStorage.getItem(TOKEN) || '';

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'onclick') e.onclick = v;
      else if (k === 'style') e.style.cssText = v;
      else e.setAttribute(k, v);
    }
    for (const c of children) if (c != null) e.append(c);
    return e;
  }

  const fmt = (n) => (Math.floor(n * 10 + 1e-9) / 10).toFixed(1);
  const when = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

  function show(kind, ...children) {
    const box = $('msg');
    box.replaceChildren();
    if (kind) box.append(el('div', { class: 'msg ' + kind }, ...children));
  }

  async function api(method, path, body) {
    const form = body instanceof FormData;
    const res = await fetch('/admin/api' + path, {
      method,
      headers: { authorization: 'Bearer ' + token, ...(body && !form ? { 'content-type': 'application/json' } : {}) },
      body: form ? body : body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401) { logout(); throw new Error(json.error || '관리자 토큰이 맞지 않습니다.'); }
    if (!res.ok) throw new Error(json.error || '오류 ' + res.status);
    return json;
  }

  async function act(fn) {
    try { await fn(); } catch (e) { show('err', e.message); }
  }

  function askWood(label) {
    const raw = prompt(label);
    if (raw == null || raw.trim() === '') return null;
    return Number(raw);
  }

  async function copy(text, what) {
    await navigator.clipboard.writeText(text);
    show('ok', what + ' 복사했습니다.');
  }

  function row(k) {
    const pct = k.granted ? Math.min(100, (k.remaining / k.granted) * 100) : 0;
    const barClass = 'bar' + (k.remaining <= 0 ? ' empty' : pct < 20 ? ' low' : '');
    const n = encodeURIComponent(k.name);
    return el('tr', {},
      el('td', {},
        el('div', {}, el('span', { class: 'name' }, k.name), k.disabled ? el('span', { class: 'tag' }, '막힘') : null),
        el('div', { class: 'sub' }, k.key.slice(0, 10) + '… · 발급 ' + when(k.createdAt))),
      el('td', {},
        el('div', {}, fmt(k.remaining) + ' / ' + k.granted),
        el('div', { class: barClass }, el('div', { style: 'width:' + pct + '%' })),
        el('div', { class: 'sub' }, '쓴 장작 ' + fmt(k.used))),
      el('td', { class: 'sub' }, when(k.lastUsedAt)),
      el('td', {}, el('div', { class: 'actions' },
        el('button', { class: 'small', onclick: () => act(async () => {
          const w = askWood(k.name + ' 님에게 충전할 장작');
          if (w == null) return;
          await api('POST', '/keys/' + n + '/topup', { wood: w });
          show('ok', k.name + ' 님에게 장작 ' + w + '개를 충전했습니다.');
          await load();
        }) }, '충전'),
        el('button', { class: 'small', onclick: () => act(async () => {
          const w = askWood(k.name + ' 님에게 준 장작을 이 값으로 바꾸기 (지금 ' + k.granted + ', 쓴 장작 ' + fmt(k.used) + ')');
          if (w == null) return;
          await api('POST', '/keys/' + n + '/set', { wood: w });
          await load();
        }) }, '변경'),
        el('button', { class: 'small', onclick: () => act(() => copy(k.key, k.name + ' 님의 키를')) }, '키 복사'),
        el('button', { class: 'small', onclick: () => act(async () => {
          await api('POST', '/keys/' + n + (k.disabled ? '/enable' : '/disable'));
          await load();
        }) }, k.disabled ? '풀기' : '막기'),
        el('button', { class: 'small danger', onclick: () => act(async () => {
          if (!confirm(k.name + ' 님의 키를 지울까요? 이 키로는 더 쓸 수 없고, 되돌릴 수 없습니다.')) return;
          await api('DELETE', '/keys/' + n);
          show('ok', k.name + ' 님의 키를 지웠습니다.');
          await load();
        }) }, '삭제'))));
  }

  const mb = (n) => (n / 1024 / 1024).toFixed(1) + 'MB';

  function relRow(r, current) {
    const on = r.id === current;
    return el('tr', {},
      el('td', {},
        el('div', {}, el('span', { class: 'name' }, r.version), on ? el('span', { class: 'tag', style: 'background:#e8f8ef;color:#087f3e' }, '설치 페이지') : null),
        el('div', { class: 'sub' }, mb(r.size))),
      el('td', { class: 'sub' }, when(r.uploadedAt)),
      el('td', { class: 'sub', style: 'white-space:pre-wrap' }, r.note || '—'),
      el('td', {}, el('div', { class: 'actions' },
        on ? null : el('button', { class: 'small', onclick: () => act(async () => {
          await api('POST', '/releases/' + r.id + '/current');
          show('ok', '설치 페이지에 ' + r.version + ' 버전을 내보냅니다.');
          await loadReleases();
        }) }, '이걸로 내보내기'),
        on ? null : el('button', { class: 'small danger', onclick: () => act(async () => {
          if (!confirm(r.version + ' 버전 파일을 지울까요?')) return;
          await api('DELETE', '/releases/' + r.id);
          await loadReleases();
        }) }, '삭제'))));
  }

  async function loadReleases() {
    const { releases, current } = await api('GET', '/releases');
    $('rel-rows').replaceChildren(...releases.map((r) => relRow(r, current)));
    $('rel-empty').hidden = releases.length > 0;
    $('rel-title').textContent = '설치 파일 버전 (' + releases.length + ')';
  }

  async function load() {
    const { keys } = await api('GET', '/keys');
    $('rows').replaceChildren(...keys.map(row));
    $('empty').hidden = keys.length > 0;
    $('list-title').textContent = '키 목록 (' + keys.length + ')';
    await loadReleases();
  }

  $('rel-file').onchange = () => {
    const f = $('rel-file').files[0];
    const v = f && f.name.match(/(\\d+\\.\\d+\\.\\d+)/);
    if (v && !$('rel-version').value) $('rel-version').value = v[1];
  };

  $('rel-form').onsubmit = (e) => {
    e.preventDefault();
    act(async () => {
      const f = $('rel-file').files[0];
      if (!f) throw new Error('zip 파일을 골라 주세요.');
      const body = new FormData();
      body.append('file', f);
      body.append('version', $('rel-version').value.trim());
      body.append('note', $('rel-note').value);
      $('rel-upload').disabled = true;
      try {
        const r = await api('POST', '/releases', body);
        $('rel-form').reset();
        show('ok', r.version + ' 버전을 올렸고, 설치 페이지에 나갑니다.');
        await loadReleases();
      } finally {
        $('rel-upload').disabled = false;
      }
    });
  };

  function logout() {
    token = '';
    sessionStorage.removeItem(TOKEN);
    $('app').hidden = true;
    $('login').hidden = false;
    $('token').focus();
  }

  async function enter() {
    $('login').hidden = true;
    $('app').hidden = false;
    show(null);
    await act(load);
  }

  $('login-form').onsubmit = async (e) => {
    e.preventDefault();
    token = $('token').value.trim();
    if (!token) return;
    try {
      await api('GET', '/keys');
      sessionStorage.setItem(TOKEN, token);
      $('token').value = '';
      await enter();
    } catch (err) {
      alert(err.message);
    }
  };

  $('logout').onclick = logout;

  $('add-form').onsubmit = (e) => {
    e.preventDefault();
    act(async () => {
      const name = $('add-name').value.trim();
      const wood = $('add-wood').value;
      if (!name || wood === '') throw new Error('이름과 장작을 써 주세요.');
      const k = await api('POST', '/keys', { name, wood: Number(wood) });
      $('add-name').value = '';
      $('add-wood').value = '';
      await load();
      show('ok', k.name + ' 님의 키를 발급했습니다: ', el('code', {}, k.key), ' ',
        el('button', { class: 'small', onclick: () => act(() => copy(k.key, '키를')) }, '복사'));
    });
  };

  if (token) enter(); else logout();
})();
</script>
</body>
</html>
`;
