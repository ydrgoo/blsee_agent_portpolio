import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  // 상용 서버 주소는 저장소에 두지 않고 apps/extension/.env 의 WXT_API_BASE_URL 에서 읽는다.
  manifest: ({ mode }) => {
    const prod = process.env.WXT_API_BASE_URL;
    if (!prod && mode === 'production') {
      throw new Error('apps/extension/.env 에 WXT_API_BASE_URL(상용 서버 주소)을 넣어 주세요.');
    }
    return {
      name: '블씨 blsee',
      description: '네이버 블로그 글쓰기 도우미 블씨',
      // 클립보드 권한은 개발자 도구(붙여넣기 기록, 이미지 복사)에만 쓴다.
      permissions: [
        'sidePanel',
        'storage',
        ...(mode === 'production' ? [] : ['clipboardRead', 'clipboardWrite']),
      ],
      host_permissions: [
        'https://blog.naver.com/*',
        'https://*.pstatic.net/*',
        ...(prod ? [`${new URL(prod).origin}/*`] : []),
        // 개발: 로컬 서버, 모의 편집기(apps/mock-editor)
        ...(mode === 'production' ? [] : ['http://localhost:8787/*', 'http://localhost:5179/*']),
      ],
      action: {
        default_title: '블씨 열기',
      },
      // 툴바 아이콘 누르기와 같아서 사이드 패널이 열린다. 사용자가 chrome://extensions/shortcuts 에서 바꿀 수 있다.
      commands: {
        _execute_action: {
          suggested_key: { default: 'Alt+Shift+B' },
          description: '블씨 열기',
        },
      },
    };
  },
  webExt: {
    // 개발용 크롬 프로필을 유지해서 네이버 로그인이 매번 풀리지 않게 한다.
    chromiumArgs: ['--user-data-dir=./.wxt/chrome-data'],
    startUrls: ['https://blog.naver.com'],
  },
});
