'use strict';

const TOKEN_KEY = 'clawdrop.ADMIN_TOKEN';
const loginView = document.querySelector('#login-view');
const appView = document.querySelector('#app-view');
const loginForm = document.querySelector('#login-form');
const tokenInput = document.querySelector('#admin-token');
const loginError = document.querySelector('#login-error');
const fileList = document.querySelector('#file-list');
const fileCount = document.querySelector('#file-count');
const fileSearch = document.querySelector('#file-search');
const filterButtons = [...document.querySelectorAll('.filter-button')];
const statusMessage = document.querySelector('#status-message');
const uploadForm = document.querySelector('#upload-form');
const uploadInput = document.querySelector('#file-upload');
const uploadButton = document.querySelector('#upload-button');
const uploadProgressWrap = document.querySelector('#upload-progress-wrap');
const uploadProgress = document.querySelector('#upload-progress');
const uploadProgressText = document.querySelector('#upload-progress-text');
const uploadStatus = document.querySelector('#upload-status');
const rateLimitStatus = document.querySelector('#rate-limit-status');
const previewDialog = document.querySelector('#preview-dialog');
const previewTitle = document.querySelector('#preview-title');
const previewMeta = document.querySelector('#preview-meta');
const previewBody = document.querySelector('#preview-body');
const previewDownload = document.querySelector('#preview-download');
const shareDialog = document.querySelector('#share-dialog');
const shareTitle = document.querySelector('#share-title');
const shareMeta = document.querySelector('#share-meta');
const shareForm = document.querySelector('#share-form');
const shareExpiresHours = document.querySelector('#share-expires-hours');
const shareMaxDownloads = document.querySelector('#share-max-downloads');
const shareCreate = document.querySelector('#share-create');
const shareError = document.querySelector('#share-error');
const shareResult = document.querySelector('#share-result');
const shareResultUrl = document.querySelector('#share-result-url');
const shareList = document.querySelector('#share-list');
const toast = document.querySelector('#toast');

let currentFiles = [];
let currentPreviewFile = null;
let currentPreviewUrl = null;
let currentShareFile = null;
let activeFilter = 'all';
let searchQuery = '';
let toastTimer = null;

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

function closeOpenDialogs() {
  if (previewDialog.open) previewDialog.close();
  if (shareDialog.open) shareDialog.close();
}

function showLogin(message = '') {
  closeOpenDialogs();
  appView.hidden = true;
  loginView.hidden = false;
  loginError.hidden = !message;
  loginError.textContent = message;
  if (message) tokenInput.focus();
}

function showApp() {
  loginView.hidden = true;
  appView.hidden = false;
}

function setStatus(message = '', isError = false) {
  statusMessage.textContent = message;
  statusMessage.classList.toggle('error', isError);
  statusMessage.hidden = !message;
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2800);
}

async function api(requestPath, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${getToken()}`);
  const response = await fetch(requestPath, { ...options, headers });
  if (response.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    showLogin('管理 token 错误或已失效');
    throw new Error('Unauthorized');
  }
  return response;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** unit);
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(2)} ${units[unit]}`;
}

function formatRateLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '100';
  return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/\.?0+$/, '');
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function fileExtension(file) {
  const dot = file.originalName.lastIndexOf('.');
  return dot >= 0 ? file.originalName.slice(dot).toLowerCase() : '';
}

function fileCategory(file) {
  const extension = fileExtension(file);
  const type = file.mimeType.toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type === 'application/pdf' || extension === '.pdf') return 'pdf';
  if (type.startsWith('text/')
      || ['.txt', '.log', '.md', '.json', '.js', '.css', '.html', '.htm'].includes(extension)) {
    return 'text';
  }
  if (['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz'].includes(extension)
      || /(zip|rar|7z|gzip|tar|compressed)/.test(type)) {
    return 'archive';
  }
  return 'other';
}

function previewKind(file) {
  const extension = fileExtension(file);
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extension)) return 'image';
  if (file.mimeType === 'application/pdf' || extension === '.pdf') return 'pdf';
  if (/^(text\/|application\/json)/.test(file.mimeType)
      || ['.txt', '.log', '.md', '.json', '.js', '.css', '.html', '.htm'].includes(extension)) {
    return 'text';
  }
  return null;
}

function visibleFiles() {
  return currentFiles.filter((file) => {
    const matchesType = activeFilter === 'all' || fileCategory(file) === activeFilter;
    const haystack = `${file.originalName} ${file.mimeType}`.toLowerCase();
    return matchesType && haystack.includes(searchQuery);
  });
}

function makeCell(text, className, label) {
  const cell = document.createElement('div');
  cell.className = `file-cell ${className}`;
  cell.dataset.label = label;
  cell.textContent = text;
  return cell;
}

function makeAction(label, handler, isDanger = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `button file-action${isDanger ? ' danger' : ''}`;
  button.textContent = label;
  button.addEventListener('click', handler);
  return button;
}

function renderFiles() {
  const files = visibleFiles();
  fileList.replaceChildren();
  fileCount.textContent = files.length === currentFiles.length
    ? `${currentFiles.length} 个文件`
    : `${files.length} / ${currentFiles.length} 个文件`;

  if (!files.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const title = document.createElement('strong');
    title.textContent = currentFiles.length ? '没有匹配文件' : '暂无文件，上传一个文件开始使用';
    const detail = document.createElement('span');
    detail.textContent = currentFiles.length
      ? '换一个关键词或文件类型试试。'
      : '可以从浏览器上传，也可以继续使用脚本投递文件。';
    empty.append(title, detail);
    fileList.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const file of files) {
    const row = document.createElement('article');
    row.className = 'file-row';

    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = file.originalName;

    const type = makeCell(file.mimeType, 'file-type', '类型 / 下载');
    const downloads = document.createElement('span');
    downloads.className = 'file-downloads';
    downloads.textContent = `${file.downloadCount} 次下载`;
    type.append(downloads);

    const actions = document.createElement('div');
    actions.className = 'file-actions';
    actions.append(
      makeAction('预览', () => previewFile(file)),
      makeAction('下载', () => downloadFile(file)),
      makeAction('创建分享', () => openShareDialog(file, true)),
      makeAction('管理分享', () => openShareDialog(file, false)),
      makeAction('删除', () => deleteFile(file), true)
    );

    row.append(
      name,
      makeCell(formatBytes(file.size), 'file-size', '大小'),
      makeCell(formatDate(file.uploadedAt), 'file-date', '上传时间'),
      type,
      actions
    );
    fragment.append(row);
  }
  fileList.append(fragment);
}

async function loadFiles() {
  setStatus('正在读取文件…');
  try {
    const response = await api('/api/files');
    if (!response.ok) throw new Error('无法读取文件列表');
    currentFiles = (await response.json()).files;
    renderFiles();
    setStatus();
    showApp();
  } catch (error) {
    if (error.message !== 'Unauthorized') {
      setStatus('无法读取文件列表，请稍后重试。', true);
    }
  }
}

async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error('Config unavailable');
    const config = await response.json();
    rateLimitStatus.textContent = `当前下载限速：${formatRateLimit(config.downloadRateLimitKb)} KB/s`;
  } catch {
    rateLimitStatus.textContent = '当前下载限速：100 KB/s';
  }
}

function setUploadStatus(message = '', isError = false) {
  uploadStatus.textContent = message;
  uploadStatus.classList.toggle('error', isError);
  uploadStatus.hidden = !message;
}

function setUploadProgress(percent) {
  uploadProgressWrap.hidden = false;
  if (Number.isFinite(percent)) {
    const bounded = Math.max(0, Math.min(100, Math.round(percent)));
    uploadProgress.value = bounded;
    uploadProgressText.textContent = `${bounded}%`;
  } else {
    uploadProgress.removeAttribute('value');
    uploadProgressText.textContent = '上传中…';
  }
}

function resetUploadProgress() {
  uploadProgress.value = 0;
  uploadProgress.setAttribute('value', '0');
  uploadProgressText.textContent = '0%';
  uploadProgressWrap.hidden = true;
}

function uploadSelectedFile(file) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/files');
    request.responseType = 'json';
    request.setRequestHeader('Authorization', `Bearer ${getToken()}`);
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        setUploadProgress((event.loaded / event.total) * 100);
      } else {
        setUploadProgress(null);
      }
    });
    request.addEventListener('load', () => {
      const body = request.response || {};
      if (request.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        showLogin('管理 token 错误或已失效');
        reject(new Error('Unauthorized'));
        return;
      }
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(body.error || '上传失败'));
        return;
      }
      resolve(body.file);
    });
    request.addEventListener('error', () => reject(new Error('网络错误，上传失败')));
    request.addEventListener('abort', () => reject(new Error('上传已取消')));

    const form = new FormData();
    form.append('file', file);
    request.send(form);
  });
}

function revokePreviewUrl() {
  if (currentPreviewUrl) URL.revokeObjectURL(currentPreviewUrl);
  currentPreviewUrl = null;
}

async function previewFile(file) {
  currentPreviewFile = file;
  previewTitle.textContent = file.originalName;
  previewMeta.textContent = `${formatBytes(file.size)} · ${file.mimeType} · ${file.downloadCount} 次下载`;
  previewBody.replaceChildren();
  previewBody.textContent = '正在载入预览…';
  previewDialog.showModal();

  const kind = previewKind(file);
  if (!kind) {
    previewBody.textContent = '此文件类型暂不支持预览，可直接下载。';
    return;
  }

  try {
    const response = await api(file.previewUrl);
    if (!response.ok) {
      if (response.status === 415) {
        throw new Error('此文件类型暂不支持预览，可直接下载。');
      }
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || '无法预览此文件');
    }
    const blob = await response.blob();
    previewBody.replaceChildren();
    if (kind === 'text') {
      const pre = document.createElement('pre');
      pre.textContent = await blob.text();
      previewBody.append(pre);
      return;
    }

    currentPreviewUrl = URL.createObjectURL(blob);
    if (kind === 'image') {
      const image = document.createElement('img');
      image.src = currentPreviewUrl;
      image.alt = file.originalName;
      previewBody.append(image);
    } else if (kind === 'pdf') {
      const frame = document.createElement('iframe');
      frame.src = currentPreviewUrl;
      frame.title = `${file.originalName} 预览`;
      previewBody.append(frame);
    }
  } catch (error) {
    previewBody.textContent = error.message === 'Unauthorized'
      ? '管理 token 错误或已失效'
      : error.message;
  }
}

async function downloadFile(file) {
  try {
    const response = await api(file.downloadUrl);
    if (!response.ok) throw new Error('下载失败');
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = file.originalName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    file.downloadCount += 1;
    renderFiles();
  } catch (error) {
    if (error.message !== 'Unauthorized') showToast('下载失败，请重试');
  }
}

async function copyText(text, input) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    input.focus();
    input.select();
    if (!document.execCommand('copy')) throw new Error('Copy failed');
  }
}

function shareStatus(share) {
  if (share.isExpired) return { text: '已过期', className: 'inactive' };
  if (share.isLimitReached) return { text: '次数已用完', className: 'inactive' };
  return { text: `有效 · ${formatDate(share.expiresAt)} 到期`, className: 'active' };
}

function renderShares(shares) {
  shareList.replaceChildren();
  if (!shares.length) {
    const empty = document.createElement('div');
    empty.className = 'share-list-empty';
    empty.textContent = '还没有有效或历史未撤销的分享链接。';
    shareList.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const share of shares) {
    const item = document.createElement('article');
    item.className = 'share-item';
    const urlInput = document.createElement('input');
    urlInput.className = 'share-item-url';
    urlInput.type = 'text';
    urlInput.readOnly = true;
    urlInput.value = share.fullUrl;
    urlInput.setAttribute('aria-label', '分享链接');

    const meta = document.createElement('div');
    meta.className = 'share-item-meta';
    const status = document.createElement('span');
    const statusInfo = shareStatus(share);
    status.className = `share-item-status ${statusInfo.className}`;
    status.textContent = statusInfo.text;
    const count = document.createElement('span');
    count.textContent = share.maxDownloads === null
      ? `${share.downloadCount} 次下载 · 不限次数`
      : `${share.downloadCount} / ${share.maxDownloads} 次下载`;
    meta.append(status, count);

    const actions = document.createElement('div');
    actions.className = 'share-item-actions';
    actions.append(
      makeAction('复制链接', async () => {
        try {
          await copyText(share.fullUrl, urlInput);
          showToast('分享链接已复制');
        } catch {
          showToast('复制失败，请手动复制');
        }
      }),
      makeAction('撤销', () => revokeShare(share), true)
    );
    item.append(urlInput, meta, actions);
    fragment.append(item);
  }
  shareList.append(fragment);
}

async function loadShares() {
  if (!currentShareFile) return;
  shareList.textContent = '正在读取分享链接…';
  try {
    const response = await api(`/api/files/${currentShareFile.id}/shares`);
    if (!response.ok) throw new Error('无法读取分享链接');
    renderShares((await response.json()).shares);
  } catch (error) {
    if (error.message !== 'Unauthorized') {
      shareList.textContent = '无法读取分享链接，请稍后重试。';
    }
  }
}

async function openShareDialog(file, focusCreate) {
  currentShareFile = file;
  shareTitle.textContent = `分享 ${file.originalName}`;
  shareMeta.textContent = `${formatBytes(file.size)} · ${file.mimeType}`;
  shareExpiresHours.value = '24';
  shareMaxDownloads.value = '';
  shareResult.hidden = true;
  shareResultUrl.value = '';
  shareError.hidden = true;
  shareDialog.showModal();
  await loadShares();
  if (focusCreate) shareExpiresHours.focus();
}

async function revokeShare(share) {
  if (!window.confirm('确认撤销这个分享链接？撤销后无法恢复。')) return;
  try {
    const response = await api(`/api/shares/${share.id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('撤销失败');
    showToast('分享链接已撤销');
    await loadShares();
  } catch (error) {
    if (error.message !== 'Unauthorized') showToast('撤销失败，请重试');
  }
}

async function deleteFile(file) {
  const confirmed = window.confirm(`确认删除“${file.originalName}”？此操作会同时使相关分享链接失效，且无法撤销。`);
  if (!confirmed) return;
  try {
    const response = await api(`/api/files/${file.id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('删除失败');
    currentFiles = currentFiles.filter((item) => item.id !== file.id);
    renderFiles();
    showToast('文件已删除');
  } catch (error) {
    if (error.message !== 'Unauthorized') showToast('删除失败，请重试');
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = tokenInput.value.trim();
  if (!token) return;
  localStorage.setItem(TOKEN_KEY, token);
  loginError.hidden = true;
  await loadFiles();
  tokenInput.value = '';
});

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = uploadInput.files && uploadInput.files[0];
  if (!file) {
    setUploadStatus('请选择一个文件。', true);
    return;
  }
  uploadButton.disabled = true;
  setUploadStatus(`正在上传 ${file.name}…`);
  setUploadProgress(0);
  try {
    await uploadSelectedFile(file);
    setUploadProgress(100);
    setUploadStatus('上传完成，文件列表已刷新。');
    uploadInput.value = '';
    await loadFiles();
    showToast('文件已上传');
    setTimeout(resetUploadProgress, 900);
  } catch (error) {
    if (error.message !== 'Unauthorized') {
      setUploadStatus(error.message, true);
    }
  } finally {
    uploadButton.disabled = false;
  }
});

uploadInput.addEventListener('change', () => {
  resetUploadProgress();
  setUploadStatus();
});

fileSearch.addEventListener('input', () => {
  searchQuery = fileSearch.value.trim().toLowerCase();
  renderFiles();
});

for (const button of filterButtons) {
  button.addEventListener('click', () => {
    activeFilter = button.dataset.filter;
    for (const item of filterButtons) {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    }
    renderFiles();
  });
}

shareForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentShareFile) return;
  shareError.hidden = true;
  shareCreate.disabled = true;
  const maxDownloads = shareMaxDownloads.value.trim() === ''
    ? null
    : Number(shareMaxDownloads.value);
  try {
    const response = await api(`/api/files/${currentShareFile.id}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expiresInHours: Number(shareExpiresHours.value),
        maxDownloads
      })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || '创建分享链接失败');
    shareResultUrl.value = body.share.fullUrl;
    shareResult.hidden = false;
    showToast('分享链接已创建');
    await loadShares();
  } catch (error) {
    if (error.message !== 'Unauthorized') {
      shareError.textContent = error.message;
      shareError.hidden = false;
    }
  } finally {
    shareCreate.disabled = false;
  }
});

document.querySelector('#share-result-copy').addEventListener('click', async () => {
  try {
    await copyText(shareResultUrl.value, shareResultUrl);
    showToast('分享链接已复制');
  } catch {
    showToast('复制失败，请手动复制');
  }
});

document.querySelector('#refresh-button').addEventListener('click', loadFiles);
document.querySelector('#logout-button').addEventListener('click', () => {
  localStorage.removeItem(TOKEN_KEY);
  currentFiles = [];
  searchQuery = '';
  fileSearch.value = '';
  showLogin();
});
document.querySelector('#preview-close').addEventListener('click', () => previewDialog.close());
document.querySelector('#share-close').addEventListener('click', () => shareDialog.close());
document.querySelector('#share-refresh').addEventListener('click', loadShares);

previewDialog.addEventListener('close', () => {
  revokePreviewUrl();
  previewBody.replaceChildren();
  currentPreviewFile = null;
});
previewDialog.addEventListener('click', (event) => {
  if (event.target === previewDialog) previewDialog.close();
});
previewDownload.addEventListener('click', () => {
  if (currentPreviewFile) downloadFile(currentPreviewFile);
});
shareDialog.addEventListener('close', () => {
  currentShareFile = null;
  shareList.replaceChildren();
  shareResult.hidden = true;
  shareError.hidden = true;
});
shareDialog.addEventListener('click', (event) => {
  if (event.target === shareDialog) shareDialog.close();
});

loadConfig();

if (getToken()) {
  loadFiles();
} else {
  showLogin();
}
