import type { BackgroundRequest, ContentResponse } from '@/lib/messages';
import { leavePanelAction } from '@/lib/panel-action';

export default defineBackground(() => {
  browser.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(console.error);

  browser.runtime.onMessage.addListener((msg: BackgroundRequest, sender, sendResponse) => {
    if (msg?.type === 'open-panel') {
      if (sender.tab?.id === undefined) return;
      const opened = browser.sidePanel.open({ tabId: sender.tab.id });
      Promise.all([opened, msg.preset ? leavePanelAction(msg.preset) : null]).then(
        () => sendResponse({ ok: true, result: null } satisfies ContentResponse<null>),
        (err) => sendResponse({ ok: false, error: String(err) } satisfies ContentResponse<null>),
      );
      return true;
    }
  });
});
