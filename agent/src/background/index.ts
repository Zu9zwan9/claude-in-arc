/*
 * background/index.ts — service worker (M1)
 * -----------------------------------------------------------------------------
 * Phase-1 service worker shell. In M1 its only job is to open the panel:
 *   - On real Chromium (native chrome.sidePanel): open the side panel for the
 *     active tab on the toolbar-action user gesture.
 *   - On Arc / browsers without chrome.sidePanel: open/focus the popup fallback.
 *
 * The orchestration responsibilities the architecture assigns to the service
 * worker — tool loop, consent broker, audit writer, provider calls — are NOT
 * implemented in M1 (see src/lib/safety, src/lib/providers, src/types stubs).
 * -----------------------------------------------------------------------------
 */

import {
  DEFAULT_PANEL_PATH,
  hasNativeSidePanel,
  openOrFocusPanel,
  registerPanelCleanup,
} from "../lib/sidepanel-fallback";

registerPanelCleanup();

chrome.action.onClicked.addListener((tab) => {
  const tabId = tab?.id ?? null;

  if (hasNativeSidePanel()) {
    if (tabId != null) {
      chrome.sidePanel.setOptions({
        tabId,
        path: `${DEFAULT_PANEL_PATH}?tabId=${tabId}`,
        enabled: true,
      });
      // Must run within the user gesture from action.onClicked.
      void chrome.sidePanel.open({ tabId });
    }
    return;
  }

  // Arc / no native side panel: reusable popup window keyed by tab id.
  void openOrFocusPanel(tabId);
});
