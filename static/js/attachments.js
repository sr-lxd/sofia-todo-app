/**
 * 附件管理功能
 * 版本: v1.10.0
 */

(() => {
  console.log('[Attachments] Module loading...');

  // ==================== 全局变量 ====================
  let currentTodoId = null;
  let currentUserId = null;

  // DOM 元素
  const attachmentOverlay = document.getElementById('attachment-overlay');
  const attachmentList = document.getElementById('attachment-list');
  const attachmentEmpty = document.getElementById('attachment-empty');
  const uploadArea = document.getElementById('upload-area');
  const fileInput = document.getElementById('attachment-file-input');
  const uploadProgress = document.getElementById('upload-progress');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');
  const quotaInfo = document.getElementById('quota-info');
  const quotaUsedBar = document.getElementById('quota-used-bar');
  const quotaText = document.getElementById('quota-text');
  const closeBtn = document.getElementById('attachment-close-btn');
  const cancelBtn = document.getElementById('attachment-cancel-btn');

  // ==================== 工具函数 ====================

  function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function formatDate(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    const diffMinutes = Math.floor(diff / 60000);
    const diffHours = Math.floor(diff / 3600000);
    const diffDays = Math.floor(diff / 86400000);

    if (diffMinutes < 1) return '刚刚';
    if (diffMinutes < 60) return `${diffMinutes}分钟前`;
    if (diffHours < 24) return `${diffHours}小时前`;
    if (diffDays < 7) return `${diffDays}天前`;

    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function getFileIcon(mimeType, filename) {
    if (mimeType.startsWith('image/')) return '🖼️';
    if (mimeType === 'application/pdf') return '📄';
    if (mimeType.includes('word') || filename.endsWith('.doc') || filename.endsWith('.docx')) return '📝';
    if (mimeType.includes('excel') || filename.endsWith('.xls') || filename.endsWith('.xlsx')) return '📊';
    if (mimeType.includes('powerpoint') || filename.endsWith('.ppt') || filename.endsWith('.pptx')) return '📽️';
    if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('7z')) return '📦';
    if (mimeType.includes('audio')) return '🎵';
    if (mimeType.includes('video')) return '🎬';
    if (mimeType.includes('text')) return '📃';
    return '📎';
  }

  function getUserId() {
    return localStorage.getItem('todo-app-user-id') || '';
  }

  function showToast(message, type = 'info') {
    // 简单的提示实现（可以改用现有的提示系统）
    const toast = document.createElement('div');
    toast.className = `attachment-toast ${type}`;
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 12px 20px;
      background: ${type === 'error' ? '#f44336' : type === 'success' ? '#4caf50' : '#2196f3'};
      color: white;
      border-radius: 4px;
      z-index: 10000;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    `;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ==================== API 请求 ====================

  async function fetchAttachments(todoId) {
    const userId = getUserId();
    const response = await fetch(`/todo/api/todos/${todoId}/attachments?user_id=${userId}`);
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || '获取附件列表失败');
    }
    return await response.json();
  }


  // ==================== 批量获取附件数量 ====================

  async function batchFetchAttachmentCounts(todoIds) {
    const userId = getUserId();
    if (!userId || !todoIds || todoIds.length === 0) return {};

    try {
      const response = await fetch('/todo/api/batch-attachment-counts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          user_id: userId,
          todo_ids: todoIds
        })
      });

      if (!response.ok) {
        throw new Error('批量获取附件数量失败');
      }

      const result = await response.json();
      return result.data.counts || {};
    } catch (error) {
      console.warn('[Attachments] 批量获取失败，回退到单个请求:', error);
      return {};
    }
  }

  async function uploadFile(todoId, file, onProgress) {
    const userId = getUserId();
    const formData = new FormData();
    formData.append('file', file);

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) {
          const percent = (e.loaded / e.total) * 100;
          onProgress(percent);
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          try {
            const error = JSON.parse(xhr.responseText);
            reject(new Error(error.error || '上传失败'));
          } catch {
            reject(new Error(`上传失败: ${xhr.status}`));
          }
        }
      });

      xhr.addEventListener('error', () => {
        reject(new Error('网络错误'));
      });

      xhr.open('POST', `/todo/api/todos/${todoId}/attachments?user_id=${userId}`);
      xhr.send(formData);
    });
  }

  async function deleteAttachment(attId) {
    const userId = getUserId();
    const response = await fetch(`/todo/api/attachments/${attId}?user_id=${userId}`, {
      method: 'DELETE'
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || '删除失败');
    }
    return await response.json();
  }

  async function loadUserQuota() {
    const userId = getUserId();
    const response = await fetch(`/todo/api/users/${userId}/quota?user_id=${userId}`);
    if (!response.ok) return;
    const result = await response.json();
    if (result.code === 0) {
      updateQuotaDisplay(result.data);
    }
  }

  // ==================== UI 渲染 ====================

  function renderAttachments(attachments) {
    // 在页面模式下更新标题中的附件计数
    const pageCount = document.getElementById('page-attachment-count');
    if (pageCount) {
      const count = attachments ? attachments.length : 0;
      pageCount.textContent = `(${count}个附件)`;
      pageCount.style.display = count > 0 ? 'inline' : 'none';
    }

    if (!attachments || attachments.length === 0) {
      attachmentEmpty.style.display = 'block';
      attachmentList.innerHTML = '';
      attachmentList.appendChild(attachmentEmpty);
      return;
    }

    attachmentEmpty.style.display = 'none';
    attachmentList.innerHTML = '';

    attachments.forEach(att => {
      const item = document.createElement('div');
      item.className = 'attachment-item';

      // 判断是否为图像文件
      const isImage = att.mime_type && att.mime_type.startsWith('image/');
      const userId = getUserId();
      const thumbnailUrl = `/todo/api/attachments/${att.id}/download?user_id=${userId}`;

      // 根据是否为图像选择不同的显示方式
      const iconHtml = isImage
        ? `<div class="file-thumbnail" data-id="${att.id}" data-filename="${att.filename}" style="cursor: pointer;" title="点击查看大图"><img src="${thumbnailUrl}" alt="${att.filename}" loading="lazy" onerror="this.parentElement.innerHTML='🖼️'"></div>`
        : `<div class="file-icon" style="cursor: pointer;" title="点击打开文件">${getFileIcon(att.mime_type, att.filename)}</div>`;

      item.innerHTML = `
        ${iconHtml}
        <div class="file-info">
          <div class="file-name" title="${att.filename}">${att.filename}</div>
          <div class="file-meta">${att.file_size_text} · ${formatDate(att.uploaded_at)}</div>
        </div>
        <div class="file-actions">
          <button class="file-action-btn download-btn" data-id="${att.id}" title="下载">⬇️</button>
          <button class="file-action-btn delete-btn" data-id="${att.id}" title="删除">🗑️</button>
        </div>
      `;

      // 绑定缩略图点击事件（查看大图）
      const thumbnail = item.querySelector('.file-thumbnail');
      if (thumbnail) {
        thumbnail.addEventListener('click', () => {
          const userId = getUserId();
          const url = `/todo/api/attachments/${att.id}/download?user_id=${userId}`;
          window.open(url, '_blank');
        });
      }

      // 绑定文件图标点击事件（打开文件）
      const fileIcon = item.querySelector('.file-icon');
      if (fileIcon) {
        fileIcon.addEventListener('click', () => {
          const userId = getUserId();
          const url = `/todo/api/attachments/${att.id}/download?user_id=${userId}`;
          window.open(url, '_blank');
        });
      }

      // 绑定下载事件
      item.querySelector('.download-btn').addEventListener('click', () => {
        downloadAttachment(att.id, att.filename);
      });

      // 绑定删除事件
      item.querySelector('.delete-btn').addEventListener('click', async () => {
        if (!confirm(`确定要删除附件「${att.filename}」吗？`)) return;

        try {
          await deleteAttachment(att.id);
          showToast('删除成功', 'success');
          await loadAttachments(currentTodoId);
          await loadUserQuota();
          // updateAttachmentCount(currentTodoId); // 改用批量更新
    if (window.batchFetchAttachmentCounts) window.batchFetchAttachmentCounts();
        } catch (error) {
          showToast(error.message, 'error');
        }
      });

      attachmentList.appendChild(item);
    });
  }

  function updateQuotaDisplay(quota) {
    const percentage = quota.percentage || 0;
    quotaUsedBar.style.width = `${percentage}%`;
    quotaText.textContent = `已使用 ${quota.used_text} / ${quota.total_text} (${percentage.toFixed(1)}%)`;

    // 根据使用率改变颜色
    if (percentage > 90) {
      quotaUsedBar.style.background = '#f44336';
    } else if (percentage > 70) {
      quotaUsedBar.style.background = '#ff9800';
    } else {
      quotaUsedBar.style.background = '#4caf50';
    }
  }
  // ========== 已弃用 (2025-11-25) ==========
  // 单独更新函数已废弃，改用批量更新机制 (batchFetchAttachmentCounts)
  // 原因：批量更新性能更好，减少API请求，响应时间从500ms降到100ms
  // ==========================================

  // 提供空函数以保持向后兼容
  function updateAttachmentCount(todoId) {
    // 已废弃，现在使用 window.batchFetchAttachmentCounts() 替代
    console.log('[Attachments] updateAttachmentCount is deprecated, use window.batchFetchAttachmentCounts() instead');
    if (window.batchFetchAttachmentCounts) {
      window.batchFetchAttachmentCounts();
    }
  }

  function downloadAttachment(attId, filename) {
    const userId = getUserId();
    const url = `/todo/api/attachments/${attId}/download?user_id=${userId}`;

    // 创建隐藏的下载链接
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    showToast('开始下载...', 'info');
  }

  // ==================== 文件上传 ====================

  async function handleFileUpload(files) {
    if (!files || files.length === 0) return;

    // 限制最多上传55个文件
    if (files.length > 55) {
      showToast(`一次最多上传55个文件，您选择了${files.length}个`, 'error');
      return;
    }

    // 显示进度条
    uploadProgress.hidden = false;

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        // 更新进度信息
        progressFill.style.width = '0%';
        progressText.textContent = `正在上传 ${file.name} (${i + 1}/${files.length})...`;

        // 上传文件
        await uploadFile(currentTodoId, file, (percent) => {
          progressFill.style.width = `${percent}%`;
          progressText.textContent = `正在上传 ${file.name} (${i + 1}/${files.length}) - ${percent.toFixed(0)}%`;
        });

        successCount++;
        showToast(`${file.name} 上传成功`, 'success');

      } catch (error) {
        failCount++;
        console.error(`[Upload Error] File: ${file.name}`, error);
        console.error('[Upload Error] Error details:', {
          message: error.message,
          stack: error.stack,
          file: file.name,
          size: file.size,
          type: file.type
        });
        showToast(`${file.name} 上传失败: ${error.message}`, 'error');
      }
    }

    // 隐藏进度条
    uploadProgress.hidden = true;

    // 显示总结信息
    if (files.length > 1) {
      if (failCount === 0) {
        showToast(`全部完成！成功上传 ${successCount} 个文件`, 'success');
      } else {
        showToast(`上传完成：成功 ${successCount} 个，失败 ${failCount} 个`, 'info');
      }
    }

    // 刷新列表
    await loadAttachments(currentTodoId);
    await loadUserQuota();
    // updateAttachmentCount(currentTodoId); // 改用批量更新
    if (window.batchFetchAttachmentCounts) window.batchFetchAttachmentCounts();
  }

  async function loadAttachments(todoId) {
    try {
      const result = await fetchAttachments(todoId);
      if (result.code === 0) {
        renderAttachments(result.data.attachments);
      }
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  // ==================== 事件绑定 ====================

  // 文件选择
  if (fileInput) {
    fileInput.addEventListener('change', async (e) => {
      await handleFileUpload(e.target.files);
      fileInput.value = ''; // 清空以便再次选择相同文件
    });
  }

  // 点击上传区域
  if (uploadArea) {
    uploadArea.addEventListener('click', (e) => {
      // 修复：pointer-events: none 导致点击穿透，改为直接检查是否在上传中
      if (uploadProgress && !uploadProgress.hidden) return;
      fileInput.click();
    });
    // 拖拽上传
    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.classList.add('drag-over');
    });

    uploadArea.addEventListener('dragleave', () => {
      uploadArea.classList.remove('drag-over');
    });

    uploadArea.addEventListener('drop', async (e) => {
      e.preventDefault();
      uploadArea.classList.remove('drag-over');
      await handleFileUpload(e.dataTransfer.files);
    });
  }

  // 关闭对话框
  function closeDialog() {
    attachmentOverlay.hidden = true;
    currentTodoId = null;
  }

  if (closeBtn) closeBtn.addEventListener('click', closeDialog);
  if (cancelBtn) cancelBtn.addEventListener('click', closeDialog);

  // 点击遮罩关闭
  if (attachmentOverlay) {
    attachmentOverlay.addEventListener('click', (e) => {
      if (e.target === attachmentOverlay) {
        closeDialog();
      }
    });
  }

  // 监听附件按钮点击（使用事件委托）
  document.addEventListener('click', (e) => {
    const attachmentBtn = e.target.closest('.attachment-btn');
    if (!attachmentBtn) return;

    e.preventDefault();
    const todoId = attachmentBtn.getAttribute('data-todo-id');
    if (!todoId) {
      showToast('无法获取任务ID', 'error');
      return;
    }

    const userId = getUserId();
    
    // 跳转到独立的附件管理页面
    window.location.href = `/todo/attachments?todo_id=${todoId}&user_id=${userId}`;
  });

  // ==================== 初始化附件计数 ====================

  async function initAttachmentCounts() {
    console.log('[Attachments] initAttachmentCounts called');
    const attachmentBtns = document.querySelectorAll('.attachment-btn');
    console.log('[Attachments] Found', attachmentBtns.length, 'attachment buttons');
    const todoIds = [];

    // 收集所有任务ID
    attachmentBtns.forEach(btn => {
      const todoId = btn.getAttribute('data-todo-id');
      if (todoId) {
        todoIds.push(todoId);
      }
    });

    if (todoIds.length === 0) return;

    // 批量获取所有附件数量
    console.log('[Attachments] Fetching counts for', todoIds.length, 'todos:', todoIds);
    const counts = await batchFetchAttachmentCounts(todoIds);
    console.log('[Attachments] Received counts:', counts);

    // 更新所有按钮
    attachmentBtns.forEach(btn => {
      const todoId = btn.getAttribute('data-todo-id');
      if (todoId && counts[todoId] !== undefined) {
        const count = counts[todoId];
        const countSpan = btn.querySelector('.attachment-count');
        if (countSpan) {
          countSpan.textContent = count;
          // 根据数量添加不同样式
          if (count === 0) {
            countSpan.classList.remove('has-files');
            countSpan.classList.add('empty');
          } else {
            countSpan.classList.remove('empty');
            countSpan.classList.add('has-files');
          }
        }
      }
    });
  }

  // 不再在页面加载时自动初始化，而是由 app.js 在渲染完成后调用
  // 监听任务列表刷新事件
  window.addEventListener('todosUpdated', initAttachmentCounts);

  console.log('[Attachments] Module loaded successfully');

  // ==================== 页面模式支持 ====================

  // 检查是否为独立页面模式
  if (window.ATTACHMENT_PAGE_CONFIG) {
    console.log('[Attachments] Page mode detected');
    const { todoId, userId } = window.ATTACHMENT_PAGE_CONFIG;

    // 设置当前任务和用户
    currentTodoId = todoId;
    currentUserId = userId;

    // 隐藏对话框元素（如果存在）
    if (attachmentOverlay) {
      attachmentOverlay.style.display = 'none';
    }

    // 页面加载完成后自动加载附件
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', async () => {
        await loadAttachments(todoId);
        await loadUserQuota();
      });
    } else {
      // DOM 已经加载完成
      (async () => {
        await loadAttachments(todoId);
        await loadUserQuota();
      })();
    }
  }

  // 暴露给全局（供 app.js 调用）
  window.AttachmentManager = {
    updateCount: updateAttachmentCount,
    init: initAttachmentCounts,
    batchInit: initAttachmentCounts  // 批量初始化
  };

})();
