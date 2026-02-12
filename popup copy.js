// Gong Bulk Transcript Downloader - Popup Script

document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Check if on a Gong page
  if (!tab?.url || !tab.url.includes('app.gong.io')) {
    document.getElementById('not-gong').classList.remove('hidden');
    document.getElementById('idle').classList.add('hidden');
    return;
  }

  // Set default folder name to today's date
  const today = new Date().toISOString().split('T')[0];
  const folderInput = document.getElementById('folder-name');
  folderInput.value = today;
  document.getElementById('folder-preview').textContent = today;

  folderInput.addEventListener('input', () => {
    document.getElementById('folder-preview').textContent = folderInput.value || today;
  });

  // Get current status from background
  chrome.runtime.sendMessage({ action: 'GET_STATUS' }, (status) => {
    if (chrome.runtime.lastError) return;
    updateUI(status);
  });

  // Listen for progress updates
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'PROGRESS_UPDATE') {
      updateUI(message.data);
    }
  });

  // Start button
  document.getElementById('start-btn').addEventListener('click', () => {
    const folderName = folderInput.value.trim() || today;
    chrome.runtime.sendMessage({
      action: 'START_DOWNLOAD',
      tabId: tab.id,
      folderName,
    });
  });

  // Pause button
  document.getElementById('pause-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'PAUSE_DOWNLOAD' });
  });

  // Resume button
  document.getElementById('resume-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'RESUME_DOWNLOAD' });
  });

  // Stop button
  document.getElementById('stop-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'STOP_DOWNLOAD' });
  });

  // Open downloads folder
  document.getElementById('open-folder-btn').addEventListener('click', () => {
    chrome.downloads.showDefaultFolder();
  });

  // Restart
  document.getElementById('restart-btn').addEventListener('click', () => {
    document.getElementById('complete').classList.add('hidden');
    document.getElementById('idle').classList.remove('hidden');
  });
});

function updateUI(status) {
  if (!status) return;

  const idle = document.getElementById('idle');
  const running = document.getElementById('running');
  const complete = document.getElementById('complete');

  if (status.isRunning) {
    idle.classList.add('hidden');
    running.classList.remove('hidden');
    complete.classList.add('hidden');

    const percent = status.totalResults > 0
      ? Math.round((status.processedCount / status.totalResults) * 100)
      : 0;

    document.getElementById('progress-fill').style.width = `${percent}%`;
    document.getElementById('progress-text').textContent =
      status.isPaused ? 'Paused' : `Downloading... ${percent}%`;
    document.getElementById('page-text').textContent =
      `Page ${status.currentPage} of ${status.totalPages}`;
    document.getElementById('count-text').textContent =
      `${status.processedCount} / ${status.totalResults} transcripts`;

    // Pause/Resume toggle
    document.getElementById('pause-btn').classList.toggle('hidden', status.isPaused);
    document.getElementById('resume-btn').classList.toggle('hidden', !status.isPaused);

    // Errors
    if (status.failedCount > 0) {
      const errorText = document.getElementById('error-text');
      errorText.classList.remove('hidden');
      errorText.textContent = `${status.failedCount} failed`;
    }

    updateErrorLog(status.errors);

  } else if (status.processedCount > 0 || status.failedCount > 0) {
    // Completed
    idle.classList.add('hidden');
    running.classList.add('hidden');
    complete.classList.remove('hidden');

    document.getElementById('final-count').textContent =
      `${status.processedCount} transcripts downloaded`;

    if (status.failedCount > 0) {
      const finalErrors = document.getElementById('final-errors');
      finalErrors.classList.remove('hidden');
      finalErrors.textContent = `${status.failedCount} failed`;
    }

    updateErrorLog(status.errors);
  }
}

function updateErrorLog(errors) {
  if (!errors || errors.length === 0) return;

  const errorLog = document.getElementById('error-log');
  errorLog.classList.remove('hidden');

  const errorList = document.getElementById('error-list');
  errorList.innerHTML = errors
    .map(e => `<li><strong>${e.title}:</strong> ${e.error}</li>`)
    .join('');
}
