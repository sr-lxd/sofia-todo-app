/**
 * 分享对话框附件信息显示模块
 * 版本: v1.10.1
 */

(function() {
  console.log('[ShareAttachments] Module loading...');

  // 等待DOM和其他脚本加载完成
  window.addEventListener('load', init);

  function init() {
    console.log('[ShareAttachments] Initializing...');

    // 监听分享对话框显示事件
    const shareOverlay = document.getElementById('share-overlay');
    if (!shareOverlay) {
      console.warn('[ShareAttachments] Share overlay not found');
      return;
    }

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'hidden') {
          if (!shareOverlay.hidden) {
            console.log('[ShareAttachments] Share dialog opened');
            // 延迟执行，确保 window.currentShareTodo 已设置
            setTimeout(() => {
              const todo = window.currentShareTodo;
              if (todo && todo.id) {
                console.log('[ShareAttachments] Loading attachments for todo:', todo.id);
                loadShareAttachments(todo.id);
              } else {
                console.warn('[ShareAttachments] No todo found:', todo);
              }
            }, 150);
          }
        }
      });
    });

    observer.observe(shareOverlay, {
      attributes: true,
      attributeFilter: ['hidden']
    });

    console.log('[ShareAttachments] Observer attached');
  }

  /**
   * 加载并显示分享任务的附件信息
   */
  async function loadShareAttachments(todoId) {
    const attachmentInfo = document.getElementById('share-attachment-info');
    const attachmentCount = document.getElementById('share-attachment-count');
    const attachmentDetails = document.getElementById('share-attachment-details');

    if (!attachmentInfo || !attachmentCount || !attachmentDetails) {
      console.warn('[ShareAttachments] Required elements not found');
      return;
    }

    try {
      const userId = window.userId;
      const apiEndpoint = window.apiEndpoint;

      if (!userId || !apiEndpoint) {
        console.warn('[ShareAttachments] Missing userId or apiEndpoint');
        attachmentInfo.hidden = true;
        return;
      }

      // 获取附件列表
      // apiEndpoint 是 /todo/api/items，需要替换为正确的附件API路径
      const attachmentApiUrl = apiEndpoint.replace('/items', `/todos/${todoId}/attachments`);
      const response = await fetch(`${attachmentApiUrl}?user_id=${userId}`, {
        method: 'GET',
        credentials: 'same-origin',
      });

      if (!response.ok) {
        console.warn('[ShareAttachments] API returned:', response.status);
        attachmentInfo.hidden = true;
        return;
      }

      const data = await response.json();
      const attachments = (data.data && data.data.attachments) || [];

      console.log('[ShareAttachments] Loaded', attachments.length, 'attachments');

      if (attachments.length === 0) {
        attachmentInfo.hidden = true;
        return;
      }

      // 显示附件数量
      attachmentCount.textContent = attachments.length;

      // 渲染附件列表
      const attachmentItems = attachments.map(att => {
        const icon = att.can_preview ? '🖼️' : '📄';
        return `
          <div class="attachment-item-preview">
            <span class="attachment-item-icon">${icon}</span>
            <span class="attachment-item-name">${att.filename}</span>
            <span class="attachment-item-size">${att.file_size_text}</span>
          </div>
        `;
      }).join('');

      attachmentDetails.innerHTML = attachmentItems;
      attachmentInfo.hidden = false;

      console.log('[ShareAttachments] Display complete');

    } catch (error) {
      console.error('[ShareAttachments] Error:', error);
      attachmentInfo.hidden = true;
    }
  }

})();
