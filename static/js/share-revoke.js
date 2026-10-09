// 分享撤回功能（基于服务器端history.json）
(function() {
  'use strict';

  // 等待DOM和主app.js加载完成
  document.addEventListener('DOMContentLoaded', function() {
    console.log('[share-revoke] Module loaded (server-based)');

    // 保存分享历史到服务器
    window.saveShareHistory = async function(taskId, taskTitle, shareResults) {
      const userId = window.userId;
      if (!userId) {
        console.error('[share-revoke] Cannot save: userId is null');
        return;
      }

      // 只保存成功的分享记录
      const successRecords = shareResults
        .filter(r => r.success && r.shared_todo_id)
        .map(r => ({
          target_user_id: r.target_user_id,
          target_nickname: r.target_nickname || r.display_name,
          shared_todo_id: r.shared_todo_id
        }));

      if (successRecords.length === 0) {
        console.log('[share-revoke] No successful shares to save');
        return;
      }

      try {
        // 修复：使用basePath而不是itemsEndpoint
        const basePath = (window.apiEndpoint || '/todo/api/items').replace('/api/items', '/api');
        const response = await fetch(`${basePath}/share/history/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: userId,
            task_id: taskId,
            task_title: taskTitle,
            share_records: successRecords
          })
        });

        const data = await response.json();

        if (response.ok && data.status === 'ok') {
          console.log(`[share-revoke] Share history saved for task ${taskId}: ${successRecords.length} records`);
        } else {
          console.error('[share-revoke] Failed to save share history:', data.error || data.msg);
        }
      } catch (error) {
        console.error('[share-revoke] Failed to save share history:', error);
      }
    };

    // 从服务器获取分享历史
    window.getShareHistory = async function(taskId) {
      const userId = window.userId;
      if (!userId || !taskId) {
        console.error('[share-revoke] Cannot get: userId or taskId is null');
        return null;
      }

      try {
        // 修复：使用basePath而不是itemsEndpoint
        const basePath = (window.apiEndpoint || '/todo/api/items').replace('/api/items', '/api');
        const response = await fetch(
          `${basePath}/share/history/get?user_id=${userId}&task_id=${taskId}`,
          {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',  // 防止浏览器缓存，确保获取最新数据
          }
        );

        const data = await response.json();

        if (response.ok && data.status === 'ok') {
          return data.history;
        } else {
          console.error('[share-revoke] Failed to get share history:', data.error);
          return null;
        }
      } catch (error) {
        console.error('[share-revoke] Failed to get share history:', error);
        return null;
      }
    };

    // 从服务器删除分享历史
    window.deleteShareHistory = async function(taskId) {
      const userId = window.userId;
      if (!userId || !taskId) {
        console.error('[share-revoke] Cannot delete: userId or taskId is null');
        return;
      }

      try {
        // 修复：使用basePath而不是itemsEndpoint
        const basePath = (window.apiEndpoint || '/todo/api/items').replace('/api/items', '/api');
        const response = await fetch(`${basePath}/share/history/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: userId,
            task_id: taskId
          })
        });

        const data = await response.json();

        if (response.ok && data.status === 'ok') {
          console.log(`[share-revoke] Share history deleted for task ${taskId}`);
        } else {
          console.error('[share-revoke] Failed to delete share history:', data.error || data.msg);
        }
      } catch (error) {
        console.error('[share-revoke] Failed to delete share history:', error);
      }
    };

    // 检查并显示分享历史
    window.checkAndShowShareHistory = async function(taskId) {
      const history = await window.getShareHistory(taskId);
      console.log(`[share-revoke] checkAndShowShareHistory - taskId: ${taskId}, history:`, history);
      const historyHint = document.getElementById('share-history-hint');
      const historyCount = document.getElementById('share-history-count');

      if (!historyHint) return;

      if (history && history.records && history.records.length > 0) {
        if (historyCount) {
          historyCount.textContent = history.records.length;
        }
        historyHint.hidden = false;
        console.log(`[share-revoke] Found share history for task ${taskId}: ${history.records.length} records`);
        console.log(`[share-revoke] ACTION: Showing hint with ${history.records.length} records`);
      } else {
        historyHint.hidden = true;
        console.log(`[share-revoke] ACTION: Hiding hint (no records)`);
      }
    };

    // 撤回分享
    window.revokeShare = async function(taskId) {
      const history = await window.getShareHistory(taskId);

      if (!history || !history.records || history.records.length === 0) {
        alert('没有找到分享记录');
        return;
      }

      // 确认撤回
      const confirmed = confirm(
        `确认撤回之前分享给 ${history.records.length} 个用户的任务吗？\n\n` +
        `撤回后，这些用户将无法看到该任务。`
      );

      if (!confirmed) return;

      // 禁用撤回按钮
      const revokeBtn = document.getElementById('revoke-share-btn');
      const historyHint = document.getElementById('share-history-hint');

      if (revokeBtn) {
        revokeBtn.disabled = true;
        revokeBtn.textContent = '撤回中...';
      }

      try {
        // 撤回API使用itemsEndpoint（/api/items/share/revoke）
        const apiEndpoint = window.apiEndpoint || '/todo/api/items';
        const response = await fetch(`${apiEndpoint}/share/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            share_records: history.records
          })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || '撤回失败');
        }

        // 删除服务器端历史记录
        await window.deleteShareHistory(taskId);

        // 隐藏撤回提示
        if (historyHint) {
          historyHint.hidden = true;
        }

        const successCount = data.success_count || 0;
        alert(data.msg || `成功撤回 ${successCount} 个分享`);

      } catch (error) {
        console.error('[share-revoke] Revoke share failed:', error);
        alert(error.message || '撤回失败，请稍后重试');
      } finally {
        // 恢复按钮状态
        if (revokeBtn) {
          revokeBtn.disabled = false;
          revokeBtn.innerHTML = '<span class="revoke-icon">↩️</span><span class="revoke-text">撤回上次分享</span>';
        }
      }
    };

    // 绑定撤回按钮事件
    const revokeBtn = document.getElementById('revoke-share-btn');
    if (revokeBtn) {
      revokeBtn.addEventListener('click', function() {
        const currentShareTodo = window.currentShareTodo;
        if (currentShareTodo && currentShareTodo.id) {
          window.revokeShare(currentShareTodo.id);
        }
      });
      console.log('[share-revoke] Revoke button event attached');
    }

    // 绑定刷新记录按钮事件
    const refreshBtn = document.getElementById('refresh-history-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async function() {
        const currentShareTodo = window.currentShareTodo;
        console.log('[share-revoke] DEBUG: currentShareTodo =', currentShareTodo);
        if (!currentShareTodo) console.error('[share-revoke] ERROR: currentShareTodo is null/undefined!');
        if (currentShareTodo && !currentShareTodo.id) console.error('[share-revoke] ERROR: currentShareTodo.id is missing!');
        if (currentShareTodo && currentShareTodo.id) {
          console.log('[share-revoke] Refreshing share history for task:', currentShareTodo.id);

          // 禁用按钮，显示刷新中状态
          refreshBtn.disabled = true;
          const originalHTML = refreshBtn.innerHTML;
          refreshBtn.innerHTML = '<span class="refresh-icon">⏳</span><span class="refresh-text">刷新中...</span>';

          try {
            // 重新调用checkAndShowShareHistory
            if (typeof window.checkAndShowShareHistory === 'function') {
              await window.checkAndShowShareHistory(currentShareTodo.id);
              console.log('[share-revoke] Share history refreshed successfully');
            }
          } catch (error) {
            console.error('[share-revoke] Failed to refresh share history:', error);
          } finally {
            // 恢复按钮状态
            refreshBtn.disabled = false;
            refreshBtn.innerHTML = originalHTML;
          }
        }
      });
      console.log('[share-revoke] Refresh button event attached');
    }

  });
})();
