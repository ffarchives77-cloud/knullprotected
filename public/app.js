/* ── KnullProtected – app.js ───────────────────────────────────────────────── */

const API = '';          // same origin
let token = localStorage.getItem('kp_token') || null;
let tabs = [];           // [{id, name, content, tab_order}]
let activeTabId = null;
let dirtyTabs = new Set();
let pendingDeleteTabId = null;
let previewMode = false;

// ── Elements ───────────────────────────────────────────────────────────────
const loader        = document.getElementById('page-loader');
const tabBar        = document.getElementById('tab-bar');
const btnAddTab     = document.getElementById('btn-add-tab');
const editor        = document.getElementById('editor');
const previewPane   = document.getElementById('preview');
const btnPreview    = document.getElementById('btn-preview');
const statusBar     = document.getElementById('status-bar');

// Auth modal
const modalAuth       = document.getElementById('modal-auth');
const modalTitle      = document.getElementById('modal-auth-title');
const modalDesc       = document.getElementById('modal-auth-desc');
const inputPassword   = document.getElementById('input-password');
const btnAuthSubmit   = document.getElementById('btn-auth-submit');
const modalAuthError  = document.getElementById('modal-auth-error');

// Change-password modal
const modalChangePw       = document.getElementById('modal-change-pw');
const inputOldPw          = document.getElementById('input-old-pw');
const inputNewPw          = document.getElementById('input-new-pw');
const inputNewPw2         = document.getElementById('input-new-pw2');
const btnChangePwSubmit   = document.getElementById('btn-change-pw-submit');
const btnChangePwCancel   = document.getElementById('btn-change-pw-cancel');
const modalPwError        = document.getElementById('modal-pw-error');

// Delete confirm modal
const modalConfirmDelete  = document.getElementById('modal-confirm-delete');
const modalDeleteDesc     = document.getElementById('modal-delete-desc');
const btnDeleteConfirm    = document.getElementById('btn-delete-confirm');
const btnDeleteCancel     = document.getElementById('btn-delete-cancel');

// ── Utilities ─────────────────────────────────────────────────────────────
function setStatus(msg) {
  statusBar.textContent = msg;
}

function showLoader() {
  loader.classList.remove('hidden');
}
function hideLoader() {
  loader.classList.add('hidden');
  // Wait for opacity transition before truly hiding
  setTimeout(() => { loader.style.display = 'none'; }, 420);
}

function loaderProgress(pct, statusText, subText) {
  const fill   = document.getElementById('loader-fill');
  const status = document.getElementById('loader-status');
  const sub    = document.getElementById('loader-sub');
  if (fill)   fill.style.width   = pct + '%';
  if (status && statusText) status.textContent = statusText;
  if (sub    && subText)    sub.textContent    = subText;
}

function authHeaders() {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(API + path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ── Tab Rendering ──────────────────────────────────────────────────────────
function renderTabs() {
  // Remove existing tab elements (keep the + button)
  [...tabBar.querySelectorAll('.tab')].forEach(el => el.remove());

  tabs.forEach(tab => {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === activeTabId ? ' active' : '');
    el.dataset.id = tab.id;

    const nameEl = document.createElement('span');
    nameEl.className = 'tab-name';
    nameEl.textContent = tab.name;
    nameEl.title = tab.name;

    // Double-click to rename
    nameEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRename(tab, el, nameEl);
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close tab';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDeleteConfirm(tab.id, tab.name);
    });

    el.appendChild(nameEl);
    el.appendChild(closeBtn);
    el.addEventListener('click', () => switchTab(tab.id));

    tabBar.insertBefore(el, btnAddTab);
  });
}

function startRename(tab, tabEl, nameEl) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tab-name-input';
  input.value = tab.name;
  tabEl.replaceChild(input, nameEl);
  input.focus();
  input.select();

  const finish = async () => {
    const newName = input.value.trim() || tab.name;
    tab.name = newName;
    tabEl.replaceChild(nameEl, input);
    nameEl.textContent = newName;
    nameEl.title = newName;
    dirtyTabs.add(tab.id);
    setStatus('Unsaved changes…');
  };

  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.value = tab.name;
      input.blur();
    }
  });
}

// ── Tab Switching ──────────────────────────────────────────────────────────
function switchTab(id) {
  // Save current editor content to in-memory tab
  if (activeTabId !== null) {
    const current = tabs.find(t => t.id === activeTabId);
    if (current && editor.value !== current.content) {
      current.content = editor.value;
      dirtyTabs.add(activeTabId);
      setStatus('Unsaved changes…');
    }
  }

  // Exit preview mode when switching tabs
  if (previewMode) exitPreview();

  activeTabId = id;
  const tab = tabs.find(t => t.id === id);
  editor.value = tab ? tab.content : '';
  editor.disabled = false;
  renderTabs();
  editor.focus();
}

// ── Load Tabs from Server ─────────────────────────────────────────────────
async function loadTabs() {
  showLoader();
  try {
    const data = await apiFetch('/api/tabs', { headers: authHeaders() });
    tabs = data;
    if (tabs.length === 0) {
      // Shouldn't normally happen, but handle gracefully
      editor.placeholder = 'No tabs yet. Click + to add one.';
      editor.disabled = true;
      activeTabId = null;
    } else {
      activeTabId = tabs[0].id;
      editor.value = tabs[0].content;
      editor.disabled = false;
    }
    dirtyTabs.clear();
    renderTabs();
    setStatus('Loaded · ' + new Date().toLocaleTimeString());
  } catch (err) {
    if (err.message === 'Invalid or expired token' || err.message === 'Unauthorized') {
      token = null;
      localStorage.removeItem('kp_token');
      showAuthModal();
    } else {
      setStatus('Error loading: ' + err.message);
    }
  } finally {
    hideLoader();
  }
}

// ── Save All Dirty Tabs ────────────────────────────────────────────────────
async function saveTabs() {
  // Flush editor to current tab
  if (activeTabId !== null) {
    const current = tabs.find(t => t.id === activeTabId);
    if (current && editor.value !== current.content) {
      current.content = editor.value;
      dirtyTabs.add(activeTabId);
    }
  }

  if (dirtyTabs.size === 0) {
    setStatus('Nothing to save.');
    return;
  }

  setStatus('Saving…');
  try {
    const saves = [...dirtyTabs].map(id => {
      const tab = tabs.find(t => t.id === id);
      if (!tab) return Promise.resolve();
      return apiFetch(`/api/tabs/${id}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ name: tab.name, content: tab.content, tab_order: tab.tab_order })
      });
    });
    await Promise.all(saves);
    dirtyTabs.clear();
    setStatus('Saved · ' + new Date().toLocaleTimeString());
  } catch (err) {
    setStatus('Save failed: ' + err.message);
  }
}

// ── Add Tab ────────────────────────────────────────────────────────────────
async function addTab() {
  try {
    const newOrder = tabs.length;
    const tab = await apiFetch('/api/tabs', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'New Tab', content: '', tab_order: newOrder })
    });
    tabs.push(tab);
    switchTab(tab.id);
    // Start renaming immediately
    const tabEl = tabBar.querySelector(`.tab[data-id="${tab.id}"]`);
    const nameEl = tabEl ? tabEl.querySelector('.tab-name') : null;
    if (tabEl && nameEl) startRename(tab, tabEl, nameEl);
    setStatus('Tab created.');
  } catch (err) {
    setStatus('Error: ' + err.message);
  }
}

// ── Delete Tab ─────────────────────────────────────────────────────────────
function openDeleteConfirm(id, name) {
  pendingDeleteTabId = id;
  modalDeleteDesc.textContent = `Delete "${name}"? This cannot be undone.`;
  modalConfirmDelete.classList.add('visible');
}

async function deleteTab() {
  const id = pendingDeleteTabId;
  pendingDeleteTabId = null;
  modalConfirmDelete.classList.remove('visible');
  if (!id) return;

  try {
    await apiFetch(`/api/tabs/${id}`, { method: 'DELETE', headers: authHeaders() });
    tabs = tabs.filter(t => t.id !== id);
    dirtyTabs.delete(id);
    if (tabs.length === 0) {
      activeTabId = null;
      editor.value = '';
      editor.disabled = true;
    } else if (activeTabId === id) {
      switchTab(tabs[0].id);
    } else {
      renderTabs();
    }
    setStatus('Tab deleted.');
  } catch (err) {
    setStatus('Error deleting: ' + err.message);
  }
}

// ── Auth Modal ─────────────────────────────────────────────────────────────
let isSetupMode = false;

async function showAuthModal() {
  showLoader();
  try {
    const status = await apiFetch('/api/status');
    isSetupMode = status.setup;
    if (isSetupMode) {
      modalTitle.textContent = 'Set up your password';
      modalDesc.textContent = 'This is your first visit. Choose a password to protect your notes.';
      btnAuthSubmit.textContent = 'Set Password';
    } else {
      modalTitle.textContent = 'Password required';
      modalDesc.textContent = 'Enter your password to access your notes.';
      btnAuthSubmit.textContent = 'Decrypt';
    }
  } catch (err) {
    modalTitle.textContent = 'Connection Error';
    modalDesc.textContent = err.message;
  }
  hideLoader();
  inputPassword.value = '';
  modalAuthError.textContent = '';
  modalAuth.classList.add('visible');
  inputPassword.focus();
}

async function submitAuth() {
  const pw = inputPassword.value.trim();
  if (!pw) return;
  modalAuthError.textContent = '';
  btnAuthSubmit.disabled = true;
  btnAuthSubmit.textContent = '…';

  try {
    const endpoint = isSetupMode ? '/api/setup' : '/api/login';
    const data = await apiFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    });
    token = data.token;
    localStorage.setItem('kp_token', token);
    modalAuth.classList.remove('visible');
    await loadTabs();
  } catch (err) {
    modalAuthError.textContent = err.message;
    btnAuthSubmit.disabled = false;
    btnAuthSubmit.textContent = isSetupMode ? 'Set Password' : 'Decrypt';
    inputPassword.focus();
  }
}

// ── Change Password ────────────────────────────────────────────────────────
async function submitChangePassword() {
  const oldPw  = inputOldPw.value.trim();
  const newPw  = inputNewPw.value.trim();
  const newPw2 = inputNewPw2.value.trim();
  modalPwError.textContent = '';

  if (!oldPw || !newPw) {
    modalPwError.textContent = 'All fields are required.';
    return;
  }
  if (newPw !== newPw2) {
    modalPwError.textContent = 'New passwords do not match.';
    return;
  }
  if (newPw.length < 4) {
    modalPwError.textContent = 'Password must be at least 4 characters.';
    return;
  }

  btnChangePwSubmit.disabled = true;
  try {
    await apiFetch('/api/change-password', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ currentPassword: oldPw, newPassword: newPw })
    });
    modalChangePw.classList.remove('visible');
    setStatus('Password changed successfully.');
  } catch (err) {
    modalPwError.textContent = err.message;
  }
  btnChangePwSubmit.disabled = false;
}

// ── Preview / Auto-link ────────────────────────────────────────────────────
const URL_REGEX = /(https?:\/\/[^\s<>"'\]\[)]+)/g;

function autoLinkText(text) {
  // Escape HTML first, then turn URLs into <a> tags
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(URL_REGEX, (url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });
}

function enterPreview() {
  // Flush textarea → in-memory
  if (activeTabId !== null) {
    const current = tabs.find(t => t.id === activeTabId);
    if (current) current.content = editor.value;
  }
  const tab = tabs.find(t => t.id === activeTabId);
  const raw = tab ? tab.content : '';
  previewPane.innerHTML = raw ? autoLinkText(raw) : '<span style="color:#aaa">nothing here yet…</span>';
  editor.hidden = true;
  previewPane.hidden = false;
  btnPreview.textContent = 'Edit';
  btnPreview.classList.add('active');
  previewMode = true;
  setStatus('Preview mode — links are clickable');
}

function exitPreview() {
  editor.hidden = false;
  previewPane.hidden = true;
  btnPreview.textContent = 'Preview';
  btnPreview.classList.remove('active');
  previewMode = false;
  editor.focus();
  setStatus('Edit mode');
}

function togglePreview() {
  if (previewMode) exitPreview(); else enterPreview();
}

// ── Keyboard Shortcuts ─────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  // Ctrl+S or Cmd+S to save
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveTabs();
  }
  // Escape to exit preview
  if (e.key === 'Escape' && previewMode) exitPreview();
});

// Track unsaved edits in textarea
editor.addEventListener('input', () => {
  if (activeTabId !== null) {
    const current = tabs.find(t => t.id === activeTabId);
    if (current) {
      current.content = editor.value;
      dirtyTabs.add(activeTabId);
      setStatus('Unsaved changes…');
    }
  }
});

// ── Event Listeners ────────────────────────────────────────────────────────
document.getElementById('btn-reload').addEventListener('click', loadTabs);
document.getElementById('btn-save').addEventListener('click', saveTabs);
btnPreview.addEventListener('click', togglePreview);
document.getElementById('btn-change-pw').addEventListener('click', () => {
  inputOldPw.value = '';
  inputNewPw.value = '';
  inputNewPw2.value = '';
  modalPwError.textContent = '';
  modalChangePw.classList.add('visible');
  inputOldPw.focus();
});

btnAddTab.addEventListener('click', addTab);
btnAuthSubmit.addEventListener('click', submitAuth);
inputPassword.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });

btnChangePwSubmit.addEventListener('click', submitChangePassword);
btnChangePwCancel.addEventListener('click', () => modalChangePw.classList.remove('visible'));

btnDeleteConfirm.addEventListener('click', deleteTab);
btnDeleteCancel.addEventListener('click', () => {
  pendingDeleteTabId = null;
  modalConfirmDelete.classList.remove('visible');
});

// Close modals on overlay click
[modalChangePw, modalConfirmDelete].forEach(m => {
  m.addEventListener('click', (e) => {
    if (e.target === m) {
      m.classList.remove('visible');
      pendingDeleteTabId = null;
    }
  });
});

// ── Init ───────────────────────────────────────────────────────────────────
(async () => {
  const startTime = Date.now();

  // Step 1: Check if IP is trusted (runs even if we already have a token,
  //         to ensure the 3-second loader always plays)
  loaderProgress(10, 'Initializing secure session', 'Connecting to server…');

  let ipTrusted = false;
  try {
    await new Promise(r => setTimeout(r, 350));  // let the bar appear
    loaderProgress(35, 'Verifying device identity', 'Checking trusted IP address…');
    const ipData = await apiFetch('/api/check-ip');
    if (ipData.trusted && ipData.token) {
      // Trusted IP — store the fresh token
      token = ipData.token;
      localStorage.setItem('kp_token', token);
      ipTrusted = true;
    }
  } catch (e) {
    // Network error or server issue — fall through to password
  }

  loaderProgress(70, ipTrusted ? 'Trusted device confirmed' : 'Verifying credentials',
                     ipTrusted ? 'Access granted — loading notes…' : 'Password will be required…');

  // Step 2: If we already had a stored token (not from IP check), mark as "known"
  const hasToken = !!token;

  // Step 3: Enforce 3-second minimum loader time
  const elapsed   = Date.now() - startTime;
  const remaining = Math.max(0, 3000 - elapsed);
  await new Promise(r => setTimeout(r, remaining));

  loaderProgress(100, hasToken ? 'Access authorised' : 'Ready', 'Loading interface…');
  await new Promise(r => setTimeout(r, 350));  // hold at 100% briefly

  // Step 4: Either load tabs or show auth modal
  if (token) {
    hideLoader();
    await loadTabs();
  } else {
    hideLoader();
    await showAuthModal();
  }
})();
