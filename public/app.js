'use strict';

const TOKEN_KEY = 'clawdrop.ADMIN_TOKEN';
const loginView = document.querySelector('#login-view');
const appView = document.querySelector('#app-view');
const loginForm = document.querySelector('#login-form');
const tokenInput = document.querySelector('#admin-token');
const loginError = document.querySelector('#login-error');
const fileList = document.querySelector('#file-list');
const fileCount = document.querySelector('#file-count');
const statusMessage = document.querySelector('#status-message');
const previewDialog = document.querySelector('#preview-dialog');
const previewTitle = document.querySelector('#preview-title');
const previewMeta = document.querySelector('#preview-meta');
const previewBody = document.querySelector('#preview-body');
const previewDownload = document.querySelector('#preview-download');
const toast = document.querySelector('#toast');

let currentFiles = [];
let currentPreviewFile = null;
let currentPreviewUrl = null;
let toastTimer = null;

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

function showLogin(message = '') {
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
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${getToken()}`);
  const response = await fetch(path, { ...options, headers });
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

function formatDate(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  }).format(new Date(value));
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

function renderFiles(files) {
  fileList.replaceChildren();
  fileCount.textContent = `${files.length} 个文件`;
  if (!files.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const title = document.createElement('strong');
    title.textContent = '文件箱还是空的';
    const detail = document.createElement('span');
    detail.textContent = '使用上传脚本投递文件后，它们会出现在这里。';
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
      makeAction('复制链接', () => copyLink(file)),
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
    const body = await response.json();
    currentFiles = body.files;
    renderFiles(currentFiles);
    setStatus();
    showApp();
  } catch (error) {
    if (error.message !== 'Unauthorized') setStatus('无法读取文件列表，请稍后重试。', true);
  }
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

  try {
    const response = await api(file.previewUrl);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || '无法预览此文件');
    }
    const blob = await response.blob();
    previewBody.replaceChildren();
    const extension = file.originalName.split('.').pop().toLowerCase();
    const isText = /^(text\/|application\/json)/.test(file.mimeType)
      || ['txt', 'log', 'md', 'json', 'js', 'css', 'html', 'htm'].includes(extension);
    if (isText) {
      const pre = document.createElement('pre');
      pre.textContent = await blob.text();
      previewBody.append(pre);
      return;
    }

    currentPreviewUrl = URL.createObjectURL(blob);
    if (file.mimeType.startsWith('image/')) {
      const image = document.createElement('img');
      image.src = currentPreviewUrl;
      image.alt = file.originalName;
      previewBody.append(image);
    } else if (file.mimeType === 'application/pdf') {
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
    renderFiles(currentFiles);
  } catch (error) {
    if (error.message !== 'Unauthorized') showToast('下载失败，请重试');
  }
}

async function copyLink(file) {
  try {
    await navigator.clipboard.writeText(new URL(file.downloadUrl, window.location.origin).href);
    showToast('已复制受保护下载链接（访问仍需管理 token）');
  } catch {
    showToast('复制失败，请手动复制地址');
  }
}

async function deleteFile(file) {
  const confirmed = window.confirm(`确认删除“${file.originalName}”？此操作无法撤销。`);
  if (!confirmed) return;
  try {
    const response = await api(`/api/files/${file.id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('删除失败');
    currentFiles = currentFiles.filter((item) => item.id !== file.id);
    renderFiles(currentFiles);
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

document.querySelector('#refresh-button').addEventListener('click', loadFiles);
document.querySelector('#logout-button').addEventListener('click', () => {
  localStorage.removeItem(TOKEN_KEY);
  currentFiles = [];
  showLogin();
});
document.querySelector('#preview-close').addEventListener('click', () => previewDialog.close());
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

if (getToken()) {
  loadFiles();
} else {
  showLogin();
}
