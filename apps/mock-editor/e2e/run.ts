/**
 * 모의 편집기 + 시험 빌드 확장으로 사이드 패널을 실제로 돌린다.
 *
 * 준비: npm run dev:server (8787), npm run dev -w @blog-helper/mock-editor (5179),
 *       cd apps/extension && npx wxt build --mode e2e
 * 실행: npx tsx apps/mock-editor/e2e/run.ts <시나리오> [글 파일]
 *
 * 시나리오마다 사이드 패널에 요청을 보내고 끝날 때까지 기다린 뒤, 화면 캡처·채팅 글·문서 전후를 OUT에 남긴다.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from 'playwright';

const EXT = fileURLToPath(new URL('../../extension/.output/chrome-mv3-e2e', import.meta.url));
const OUT = process.env.E2E_OUT ?? fileURLToPath(new URL('../.e2e-out/', import.meta.url));
const MOCK = 'http://localhost:5179';
/** 요청 하나를 기다리는 최대 시간 */
const RUN_TIMEOUT_MS = 6 * 60_000;

type Step = { say: string } | { answer: 'accept' | 'decline'; note?: string } | { select: string; to?: string };

/** 시나리오: 사이드 패널에 차례로 보낼 말. 질문 카드가 뜨면 기본으로 확인한다. */
const SCENARIOS: Record<string, Step[]> = {
  smoke: [{ say: '이 글 소제목이 몇 개야?' }],
  typo: [{ say: '글 전체 맞춤법 한번 점검해줘' }, { say: '응 고쳐줘' }],
  fact: [{ say: '이 글에 틀린 정보 있는지 봐줘' }],
  tone: [{ say: '두 번째 문단을 조금 더 부드러운 말투로 바꿔줘' }],
};

function log(...a: unknown[]) {
  console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);
}

/** 시나리오마다 새 프로필 (앞 실행의 대화가 섞이지 않게) */
async function launch(profile: string): Promise<{ ctx: BrowserContext; extId: string }> {
  mkdirSync(profile, { recursive: true });
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: process.env.E2E_HEADED ? false : true,
    channel: 'chromium',
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  return { ctx, extId };
}

/** 앞으로 가져와 캡처한다. 실패해도 시험은 이어 간다. */
async function shot(page: Page, path: string) {
  try {
    await page.bringToFront();
    await page.screenshot({ path, fullPage: true });
  } catch (err) {
    log(`캡처 실패 (${path}): ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

async function chatText(panel: Page): Promise<string> {
  return panel.evaluate(() => document.body.innerText);
}

/** 사이드 패널이 일을 마칠 때까지 기다린다. 질문 카드가 뜨면 답한다. */
async function waitIdle(panel: Page, answer: { action: 'accept' | 'decline'; note?: string } = { action: 'accept' }) {
  const start = Date.now();
  // 일이 시작될 때까지 잠깐 기다린다.
  await panel.waitForTimeout(1500);
  while (Date.now() - start < RUN_TIMEOUT_MS) {
    const card = panel.locator('.ask-card');
    if (await card.count()) {
      const q = (await card.locator('.ask-message').innerText()).slice(0, 200).replace(/\s+/g, ' ');
      log(`질문 카드: ${q} → ${answer.action}${answer.note ? ` (${answer.note})` : ''}`);
      if (answer.note) {
        const input = card.locator('.composer-inline').first();
        if (await input.count()) {
          await input.click();
          await input.pressSequentially(answer.note);
        }
      }
      await card.getByRole('button', { name: answer.action === 'accept' ? '확인' : '거절' }).click();
      await panel.waitForTimeout(800);
      continue;
    }
    const working = await panel.locator('.msg-working').count();
    // 적용 전 확인 카드가 뜨면 적용을 눌러 에디터에 반영한다.
    const proposal = panel.locator('.proposal');
    if (!working && (await proposal.count())) {
      log('적용 카드 → 적용');
      await proposal.getByRole('button', { name: '적용', exact: true }).click();
      await panel.waitForTimeout(1500);
      continue;
    }
    if (!working) return;
    await panel.waitForTimeout(1000);
  }
  throw new Error('시간 안에 끝나지 않았다');
}

async function main() {
  const name = process.argv[2] ?? 'smoke';
  const docFile = process.argv[3] ?? 'document-data.json';
  const steps = SCENARIOS[name];
  if (!steps) throw new Error(`시나리오가 없다: ${name} (${Object.keys(SCENARIOS).join(', ')})`);
  const out = `${OUT}${name}-${Date.now()}/`;
  mkdirSync(out, { recursive: true });

  const { ctx, extId } = await launch(process.env.E2E_PROFILE ?? `${out}profile/`);
  try {
    const editor = await ctx.newPage();
    editor.on('console', (m) => m.type() === 'error' && log('편집기 콘솔 오류:', m.text()));
    await editor.goto(`${MOCK}/?doc=${encodeURIComponent(docFile)}`);
    await editor.waitForSelector('.se-component');
    const before = await editor.evaluate(() => (window as unknown as { SmartEditor: { _editors: Record<string, { getDocumentData: () => unknown }> } }).SmartEditor._editors.blogpc001.getDocumentData());
    writeFileSync(`${out}doc-before.json`, JSON.stringify(before, null, 1));

    const panel = await ctx.newPage();
    panel.on('console', (m) => m.type() === 'error' && log('패널 콘솔 오류:', m.text()));
    await panel.setViewportSize({ width: 420, height: 900 });
    await panel.goto(`chrome-extension://${extId}/sidepanel.html?editorTab=mock`);
    await panel.waitForTimeout(2500);
    await shot(panel, `${out}00-panel-open.png`);

    let i = 0;
    for (const step of steps) {
      i++;
      if ('say' in step) {
        log(`보냄: ${step.say}`);
        await panel.bringToFront();
        const input = panel.locator('.composer .composer-inline');
        await input.click();
        await input.pressSequentially(step.say);
        await input.press('Enter');
        await waitIdle(panel);
      } else if ('select' in step) {
        await editor.evaluate(([a, b]) => (window as unknown as { __mock: { selectBlock: (a: string, b?: string) => void } }).__mock.selectBlock(a, b), [step.select, step.to] as const);
      }
      await shot(panel, `${out}${String(i).padStart(2, '0')}-panel.png`);
      writeFileSync(`${out}chat.txt`, await chatText(panel));
    }

    writeFileSync(`${out}chat.txt`, await chatText(panel));
    const after = await editor.evaluate(() => (window as unknown as { SmartEditor: { _editors: Record<string, { getDocumentData: () => unknown }> } }).SmartEditor._editors.blogpc001.getDocumentData());
    writeFileSync(`${out}doc-after.json`, JSON.stringify(after, null, 1));
    await shot(editor, `${out}editor-after.png`);
    log(`결과: ${out}`);
  } finally {
    await ctx.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
