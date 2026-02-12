// Gong Bulk Transcript Downloader - Background Service Worker
// New approach: open each call page in a tab, scrape transcript from DOM, save as text

// --- State ---
let state = {
  isRunning: false,
  isPaused: false,
  currentPage: 0,
  totalPages: 0,
  totalResults: 0,
  processedCount: 0,
  failedCount: 0,
  summaries: [],
  errors: [],
  folderName: '',
  searchTabId: null,
};

// --- Persist state ---
async function saveState() {
  await chrome.storage.local.set({ gongState: state });
}

async function loadState() {
  const result = await chrome.storage.local.get('gongState');
  if (result.gongState) {
    state = result.gongState;
  }
}

loadState();

// --- Keep-alive alarm for MV3 service worker ---
chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive' && state.isRunning) {
    chrome.storage.local.get('keepAlive');
  }
});

// --- Helper: Send message to content script ---
function sendToContent(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response?.error) {
        reject(new Error(response.error));
      } else {
        resolve(response);
      }
    });
  });
}

// --- Helper: Inject content script into a tab if needed ---
async function ensureContentScript(tabId) {
  try {
    await sendToContent(tabId, { action: 'PING' });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    await sleep(500);
  }
}

// --- Helper: Open a call page and wait for it to load ---
async function openCallPage(callId, baseUrl) {
  // Build the call URL using the same domain
  const urlObj = new URL(baseUrl);
  const callUrl = `${urlObj.origin}/call?id=${callId}`;

  const tab = await chrome.tabs.create({
    url: callUrl,
    active: false,
  });

  // Wait for the tab to finish loading
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timeout'));
    }, 30000);

    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });

  // Extra wait for SPA to render
  await sleep(2000);

  return tab;
}

// --- Build filename from call metadata ---
function buildFilename(call) {
  const parts = [];

  if (call.company) {
    parts.push(call.company);
  }

  if (call.date) {
    try {
      const dateStr = call.date.replace(/\s*(ET|CT|MT|PT|EST|CST|MST|PST|UTC)$/i, '').trim();
      const parsed = new Date(dateStr);
      if (!isNaN(parsed.getTime())) {
        const yyyy = parsed.getFullYear();
        const mm = String(parsed.getMonth() + 1).padStart(2, '0');
        const dd = String(parsed.getDate()).padStart(2, '0');
        parts.push(`${yyyy}-${mm}-${dd}`);
      } else {
        parts.push(call.date.split(',')[0]);
      }
    } catch {
      parts.push(call.date.split(',')[0]);
    }
  }

  if (call.title) {
    parts.push(call.title);
  }

  if (call.participants) {
    parts.push(call.participants);
  }

  const raw = parts.join(' - ') || 'Unknown Call';
  return raw
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 200);
}

// --- Format transcript entries as plain text ---
function formatTranscript(entries, callInfo) {
  const lines = [];

  // Header
  lines.push(callInfo.title || 'Call Transcript');
  if (callInfo.company) lines.push(`Company: ${callInfo.company}`);
  if (callInfo.date) lines.push(`Date: ${callInfo.date}`);
  if (callInfo.duration) lines.push(`Duration: ${callInfo.duration}`);
  if (callInfo.participants) lines.push(`Participants: ${callInfo.participants}`);
  lines.push('');
  lines.push('='.repeat(60));
  lines.push('TRANSCRIPT');
  lines.push('='.repeat(60));
  lines.push('');

  for (const entry of entries) {
    lines.push(`[${entry.timestamp}] ${entry.speaker}:`);
    lines.push(entry.text);
    lines.push('');
  }

  return lines.join('\n');
}

// --- Save text content as a file ---
async function saveTextFile(content, folder, filename) {
  const base64 = btoa(unescape(encodeURIComponent(content)));
  const dataUrl = `data:text/plain;base64,${base64}`;

  const sanitized = filename
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 200);

  await chrome.downloads.download({
    url: dataUrl,
    filename: `${folder}/${sanitized}.txt`,
    conflictAction: 'uniquify',
  });
}

// --- Broadcast progress to popup ---
function broadcastProgress() {
  chrome.runtime.sendMessage({
    type: 'PROGRESS_UPDATE',
    data: {
      isRunning: state.isRunning,
      isPaused: state.isPaused,
      currentPage: state.currentPage,
      totalPages: state.totalPages,
      totalResults: state.totalResults,
      processedCount: state.processedCount,
      failedCount: state.failedCount,
      errors: state.errors.slice(-5),
    },
  }).catch(() => {});
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Core orchestration ---
async function startBulkDownload(searchTabId, folderName) {
  state.isRunning = true;
  state.isPaused = false;
  state.searchTabId = searchTabId;
  state.folderName = folderName || new Date().toISOString().split('T')[0];
  state.processedCount = 0;
  state.failedCount = 0;
  state.summaries = [];
  state.errors = [];
  state.currentPage = 0;
  state.totalPages = 0;
  state.totalResults = 0;

  const folder = `Gong Transcripts/${state.folderName}`;

  await saveState();
  broadcastProgress();

  // Get the base URL from the search tab
  let baseUrl;
  try {
    const tab = await chrome.tabs.get(searchTabId);
    baseUrl = tab.url;
  } catch (err) {
    state.isRunning = false;
    state.errors.push({ title: 'Fatal Error', error: 'Could not get search tab URL' });
    await saveState();
    broadcastProgress();
    return;
  }

  try {
    // Step 1: Scrape the first page to get pagination info
    const firstPageData = await sendToContent(searchTabId, { action: 'SCRAPE_PAGE' });
    state.totalPages = firstPageData.pagination.totalPages;
    state.totalResults = firstPageData.pagination.totalResults;
    state.currentPage = firstPageData.pagination.currentPage;

    await saveState();
    broadcastProgress();

    // Step 2: Process all pages
    for (let page = 1; page <= state.totalPages; page++) {
      if (!state.isRunning) break;

      while (state.isPaused) {
        await sleep(500);
        if (!state.isRunning) break;
      }
      if (!state.isRunning) break;

      // Navigate to page if not already there
      if (page > 1) {
        try {
          await sendToContent(searchTabId, { action: 'NAVIGATE_PAGE', pageNumber: page });
          await sleep(1000);
        } catch (err) {
          state.errors.push({ title: `Page ${page} navigation`, error: err.message });
          state.failedCount++;
          broadcastProgress();
          continue;
        }
      }

      // Scrape current page for call metadata
      let pageData;
      try {
        pageData = await sendToContent(searchTabId, { action: 'SCRAPE_PAGE' });
      } catch (err) {
        state.errors.push({ title: `Page ${page} scrape`, error: err.message });
        state.failedCount++;
        broadcastProgress();
        continue;
      }

      state.currentPage = page;
      broadcastProgress();

      // Collect summaries
      for (const call of pageData.calls) {
        state.summaries.push({
          title: call.title,
          company: call.company,
          date: call.date,
          duration: call.duration,
          participants: call.participants,
          summary: call.summary,
          callLink: call.callLink,
          callId: call.callId,
        });
      }

      // Process each call on this page
      for (let i = 0; i < pageData.calls.length; i++) {
        if (!state.isRunning) break;
        while (state.isPaused) {
          await sleep(500);
          if (!state.isRunning) break;
        }
        if (!state.isRunning) break;

        const call = pageData.calls[i];

        if (!call.callId) {
          state.failedCount++;
          state.errors.push({
            title: call.title || `Card ${i}`,
            error: 'No call ID found in link',
            page,
          });
          broadcastProgress();
          continue;
        }

        let callTab = null;
        try {
          // Open call page in new tab
          callTab = await openCallPage(call.callId, baseUrl);

          // Ensure content script is loaded
          await ensureContentScript(callTab.id);

          // Scrape transcript
          const result = await sendToContent(callTab.id, { action: 'SCRAPE_TRANSCRIPT' });

          if (!result.success) {
            throw new Error(result.error || 'Transcript scrape failed');
          }

          if (result.entries.length === 0) {
            throw new Error('No transcript entries found');
          }

          // Format and save transcript
          const filename = buildFilename(call);
          const transcriptText = formatTranscript(result.entries, call);
          await saveTextFile(transcriptText, folder, filename);

          state.processedCount++;
          broadcastProgress();
        } catch (err) {
          state.failedCount++;
          state.errors.push({
            title: call.title || `Card ${i}`,
            error: err.message,
            page,
          });
          broadcastProgress();
        } finally {
          // Close the call tab
          if (callTab) {
            try {
              await chrome.tabs.remove(callTab.id);
            } catch {
              // Tab might already be closed
            }
          }
        }

        // Brief delay between calls
        await sleep(300);
      }

      await saveState();
    }

    // Step 3: Save summaries CSV
    if (state.summaries.length > 0) {
      await saveSummariesCSV(folder);
    }

    state.isRunning = false;
    await saveState();
    broadcastProgress();
  } catch (err) {
    state.isRunning = false;
    state.errors.push({ title: 'Fatal Error', error: err.message });
    await saveState();
    broadcastProgress();
  }
}

// --- Save summaries as CSV ---
async function saveSummariesCSV(folder) {
  const escapeCsv = (str) => `"${(str || '').replace(/"/g, '""')}"`;

  const header = 'Company,Date,Duration,Title,Participants,Summary,Call Link\n';
  const rows = state.summaries.map(s => [
    escapeCsv(s.company),
    escapeCsv(s.date),
    escapeCsv(s.duration),
    escapeCsv(s.title),
    escapeCsv(s.participants),
    escapeCsv(s.summary),
    escapeCsv(s.callLink),
  ].join(',')).join('\n');

  const csvContent = header + rows;
  const base64 = btoa(unescape(encodeURIComponent(csvContent)));
  const dataUrl = `data:text/csv;base64,${base64}`;

  try {
    await chrome.downloads.download({
      url: dataUrl,
      filename: `${folder}/call_summaries.csv`,
      conflictAction: 'uniquify',
    });
  } catch (err) {
    state.errors.push({ title: 'CSV Export', error: err.message });
  }
}

// --- Message handler from popup ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'START_DOWNLOAD') {
    startBulkDownload(message.tabId, message.folderName);
    sendResponse({ started: true });
    return true;
  }

  if (message.action === 'PAUSE_DOWNLOAD') {
    state.isPaused = true;
    saveState();
    broadcastProgress();
    sendResponse({ paused: true });
    return true;
  }

  if (message.action === 'RESUME_DOWNLOAD') {
    state.isPaused = false;
    saveState();
    broadcastProgress();
    sendResponse({ resumed: true });
    return true;
  }

  if (message.action === 'STOP_DOWNLOAD') {
    state.isRunning = false;
    state.isPaused = false;
    saveState();
    broadcastProgress();
    sendResponse({ stopped: true });
    return true;
  }

  if (message.action === 'GET_STATUS') {
    sendResponse({
      isRunning: state.isRunning,
      isPaused: state.isPaused,
      currentPage: state.currentPage,
      totalPages: state.totalPages,
      totalResults: state.totalResults,
      processedCount: state.processedCount,
      failedCount: state.failedCount,
      errors: state.errors.slice(-5),
    });
    return true;
  }
});
