// Gong Bulk Transcript Downloader - Content Script
// Injected into app.gong.io pages (both search and call pages)

(() => {
  // --- Selectors ---
  const SEL = {
    // Search page selectors
    CALL_LIST: 'ul.call-list',
    CALL_CARD: 'li.call-result',
    CALL_MAIN_LINK: 'a.call-result__main',
    CALL_TITLE: '.call-title-block',
    CALL_ROWS: '.call-result__row',
    CALL_DURATION: '.call-duration',
    CALL_SUMMARY: '[role="textbox"]',
    COMPANY_NAME: '[data-testid="show-account-info"] .gong-btn__text',
    RESULTS_COUNT: '.pagination-results-top-state',
    PAGINATION: 'ul.pagination',
    PAGE_NUMBER: 'li.page-number',
    NEXT_PAGE: 'li.next-page',

    // Call page selectors
    TRANSCRIPT_TAB: 'button, a, div',
    MONOLOGUE: '.monologue-inner',
    TIMESTAMP_SPEAKER: '.timestamp__speaker',
    TIMESTAMP_TIMER: '.timestamp__timer',
    MONOLOGUE_TEXT: '.monologue-text',
  };

  // --- Utilities ---

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function waitForElement(selector, timeout = 10000, parent = document) {
    return new Promise((resolve, reject) => {
      const existing = parent.querySelector(selector);
      if (existing) return resolve(existing);

      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timeout waiting for: ${selector}`));
      }, timeout);

      const observer = new MutationObserver(() => {
        const el = parent.querySelector(selector);
        if (el) {
          clearTimeout(timer);
          observer.disconnect();
          resolve(el);
        }
      });

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    });
  }

  // --- Scrape all call cards on the current search page ---
  function scrapeCurrentPage() {
    const cards = document.querySelectorAll(SEL.CALL_CARD);
    const calls = [];

    cards.forEach((card, index) => {
      const mainLink = card.querySelector(SEL.CALL_MAIN_LINK);
      const titleEl = mainLink?.querySelector(SEL.CALL_TITLE);
      const rows = mainLink?.querySelectorAll(SEL.CALL_ROWS);
      const durationEl = card.querySelector(SEL.CALL_DURATION);
      const summaryEl = card.querySelector(SEL.CALL_SUMMARY);
      const companyEl = card.querySelector(SEL.COMPANY_NAME);
      const callLink = mainLink?.getAttribute('href') || '';

      const title = titleEl?.textContent?.trim() || `Unknown Call ${index + 1}`;
      const participants = rows?.[0]?.textContent?.trim() || '';
      const date = rows?.[1]?.textContent?.trim() || '';
      const duration = durationEl?.textContent?.trim() || '';
      const summary = summaryEl?.textContent?.trim()?.replace(/Open call brief$/, '').trim() || '';
      const company = companyEl?.textContent?.trim() || '';

      // Extract call ID from the link (e.g., /call?id=12345)
      const callIdMatch = callLink.match(/[?&]id=(\d+)/);
      const callId = callIdMatch ? callIdMatch[1] : '';

      calls.push({
        index,
        title,
        participants,
        date,
        duration,
        summary,
        company,
        callLink,
        callId,
      });
    });

    return calls;
  }

  // --- Parse pagination info ---
  function getPaginationInfo() {
    const countEl = document.querySelector(SEL.RESULTS_COUNT);
    let totalResults = 0;
    let perPage = 10;

    if (countEl) {
      const match = countEl.textContent.match(/(\d+)\s+of\s+(\d+)/i);
      if (match) {
        perPage = parseInt(match[1], 10);
        totalResults = parseInt(match[2], 10);
      }
    }

    const pageNumbers = document.querySelectorAll(SEL.PAGE_NUMBER);
    let currentPage = 1;
    let totalPages = 1;

    if (pageNumbers.length > 0) {
      totalPages = 0;
      pageNumbers.forEach(li => {
        const num = parseInt(li.textContent.trim(), 10);
        if (!isNaN(num) && num > totalPages) totalPages = num;
        if (li.classList.contains('active')) currentPage = num;
      });
    }

    if (totalResults > 0 && perPage > 0) {
      const calculatedPages = Math.ceil(totalResults / perPage);
      if (calculatedPages > totalPages) totalPages = calculatedPages;
    }

    return { totalResults, currentPage, totalPages, perPage };
  }

  // --- Navigate to a specific page ---
  async function navigateToPage(pageNumber) {
    const pageItems = document.querySelectorAll(SEL.PAGE_NUMBER);

    for (const li of pageItems) {
      const num = parseInt(li.textContent.trim(), 10);
      if (num === pageNumber) {
        const clickTarget = li.querySelector('a') || li.querySelector('span') || li;
        clickTarget.click();
        await sleep(2500);
        try {
          await waitForElement(SEL.CALL_LIST, 5000);
        } catch (e) {
          // List might already be there
        }
        await sleep(500);
        return true;
      }
    }

    // If direct page number isn't visible, try next button
    const nextBtn = document.querySelector(`${SEL.NEXT_PAGE} a`);
    if (nextBtn) {
      nextBtn.click();
      await sleep(2500);
      try {
        await waitForElement(SEL.CALL_LIST, 5000);
      } catch (e) {
        // Continue
      }
      await sleep(500);
      return true;
    }

    throw new Error(`Could not navigate to page ${pageNumber}`);
  }

  // --- Scrape transcript from a call page ---
  async function scrapeTranscript() {
    // Click the "Transcript" tab
    const tabs = document.querySelectorAll('button, [role="tab"]');
    let transcriptTab = null;
    for (const tab of tabs) {
      if (tab.textContent.trim() === 'Transcript') {
        transcriptTab = tab;
        break;
      }
    }

    if (!transcriptTab) {
      throw new Error('Transcript tab not found on call page');
    }

    transcriptTab.click();
    await sleep(1500);

    // Wait for monologues to appear
    try {
      await waitForElement(SEL.MONOLOGUE, 8000);
    } catch (e) {
      throw new Error('Transcript content did not load');
    }

    // Wait a bit more for all content to render
    await sleep(500);

    // Extract transcript entries
    const monologues = document.querySelectorAll(SEL.MONOLOGUE);
    const entries = [];

    for (const mono of monologues) {
      const speakerEl = mono.querySelector(SEL.TIMESTAMP_SPEAKER);
      const timerEl = mono.querySelector(SEL.TIMESTAMP_TIMER);
      const textEl = mono.querySelector(SEL.MONOLOGUE_TEXT);

      const speaker = speakerEl?.textContent?.trim() || 'Unknown';
      const timestamp = timerEl?.textContent?.trim() || '';

      // Use aria-label for clean text, fallback to textContent
      let text = textEl?.getAttribute('aria-label')?.trim() || '';
      if (!text) {
        text = textEl?.textContent?.trim() || '';
      }

      if (text) {
        entries.push({ timestamp, speaker, text });
      }
    }

    return entries;
  }

  // --- Get call page metadata ---
  function getCallPageMetadata() {
    // Title is in the page header
    const titleEl = document.querySelector('h1') ||
      document.querySelector('[class*="call-title"]') ||
      document.querySelector('[class*="callTitle"]');
    const title = titleEl?.textContent?.trim() || document.title.replace(/^Gong \| /, '');

    // Date and duration from the header area
    const headerText = document.querySelector('[class*="call-header"]')?.textContent || '';

    return { title };
  }

  // --- Message handler from background script ---
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'SCRAPE_PAGE') {
      const calls = scrapeCurrentPage();
      const pagination = getPaginationInfo();
      sendResponse({ calls, pagination });
      return true;
    }

    if (message.action === 'NAVIGATE_PAGE') {
      (async () => {
        try {
          await navigateToPage(message.pageNumber);
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    if (message.action === 'SCRAPE_TRANSCRIPT') {
      (async () => {
        try {
          const entries = await scrapeTranscript();
          const metadata = getCallPageMetadata();
          sendResponse({ success: true, entries, metadata });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    if (message.action === 'PING') {
      sendResponse({ alive: true });
      return true;
    }
  });
})();
