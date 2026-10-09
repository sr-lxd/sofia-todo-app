// 页面加载时立即滚动到顶部
window.scrollTo(0, 0);

(() => {
  // 全局未捕获Promise错误处理
  window.addEventListener('unhandledrejection', (event) => {
    console.error('[todo] Unhandled promise rejection:', event.reason);
    event.preventDefault(); // 阻止默认的错误输出
  });

  const storageKeyBase = "todo-app-items";
  const preferenceKeyBase = "todo-app-preferences";
  const userIdKey = "todo-app-user-id";
  const dbName = "todo-app-db";
  const dbStore = "todos";
  const defaultPreferences = { showCompleted: false };
  const syncDelay = 400;
  // ============ 自动轮询同步配置 ============
  const pollConfigKey = "todo-app-poll-config";
  const defaultPollInterval = 30;
  const pollIntervalOptions = [0, 15, 30, 60, 120, 300];
  const {
    itemsEndpoint: apiEndpoint,
    registerEndpoint,
    loginEndpoint,
    profileEndpoint,
    nicknameEndpoint,
    searchUserEndpoint,
  } = resolveApiEndpoints();
  window.apiEndpoint = apiEndpoint; // 暴露给share-revoke.js

  const form = document.querySelector("#todo-form");
  const titleInput = document.querySelector("#todo-input");
  const contentInput = document.querySelector("#todo-content");
  const searchInput = document.querySelector("#todo-search");
  const startDateInput = document.querySelector("#todo-start-date");
  const startTimeInput = document.querySelector("#todo-start-time");
  const addButton = form.querySelector('button[type="submit"]');
  const formCancelButton = document.querySelector("#form-cancel");
  const repeatDailyInput = document.querySelector("#todo-repeat-daily");
  const repeatNoneInput = document.querySelector("#todo-repeat-none");
  const repeatCustomInput = document.querySelector("#todo-repeat-custom");
  const customRepeatPanel = document.querySelector("#custom-repeat-panel");
  const repeatPresetSelect = document.querySelector("#todo-repeat-preset");
  const customHoursField = document.querySelector("#custom-hours-field");
  const repeatHoursInput = document.querySelector("#todo-repeat-hours");
  const repeatHintWeekly = document.querySelector("#repeat-hint-weekly");
  const repeatHintMonthly = document.querySelector("#repeat-hint-monthly");
  const todoList = document.querySelector("#todo-list");
  const template = document.querySelector("#todo-item-template");
  const filters = document.querySelector(".filters");
  const countLabel = document.querySelector("#todo-count");
  const secondaryActionBtn = document.querySelector("#clear-completed");
  const todayLabel = document.querySelector("#today-label");
  const formToggle = document.querySelector("#form-toggle");
  const filterCycleBtn = document.querySelector("#filter-cycle-btn");
  const showCompletedBtn = document.querySelector("#show-completed-btn");
  const userIdOverlay = document.querySelector("#user-id-overlay");
  const userIdForm = document.querySelector("#user-id-form");
  const userIdInput = document.querySelector("#user-id-input");
  const userIdError = document.querySelector("#user-id-error");
  const userIdCancelBtn = document.querySelector("#user-id-cancel");
  const refreshBtn = document.querySelector("#refresh-btn");
  const shareChoiceMenu = document.querySelector("#share-choice-menu");
  const shareToAppBtn = document.querySelector("#share-to-app-btn");
  const shareToWechatBtn = document.querySelector("#share-to-wechat-btn");
  const shareOverlay = document.querySelector("#share-overlay");
  const shareForm = document.querySelector("#share-form");
  const shareTargetUser = document.querySelector("#share-target-user");
  const shareError = document.querySelector("#share-error");
  const shareCancelBtn = document.querySelector("#share-cancel");
  const selectedUsersContainer = document.querySelector("#selected-users-container");
  const userDropdown = document.querySelector("#user-dropdown");
  const currentUserInfo = document.querySelector("#current-user-info");
  const currentNickname = document.querySelector("#current-nickname");
  const currentUserId = document.querySelector("#current-user-id");
  const copyUserIdBtn = document.querySelector("#copy-user-id-btn");
  const myNicknameSpan = document.querySelector("#my-nickname");

  // 分享功能：已选择的用户列表
  let selectedUsers = []; // 格式：[{userId, nickname}, ...]
  let allUsersList = []; // 所有用户列表（从服务器获取）

  // 新增：持久化状态
  let persistedStatus = null; // null=未知 true/false

  let dbPromise = openDatabase();
  let todos = [];
  let activeFilter = "all";
  let preferences = { ...defaultPreferences };
  let showCompleted = defaultPreferences.showCompleted;
  let syncTimer = null;
  let userId = null;
  let userNickname = null;  // 新增：用户昵称
  let nicknamePrompted = false;  // 新增：标记是否已经提示过设置昵称
  let storageKey = storageKeyBase;
  let preferenceKey = preferenceKeyBase;
  let searchTerms = [];

  // ============ 自动轮询同步变量 ============
  let pollTimer = null;
  let lastDataHash = null;
  let currentPollInterval = null;


  // ============ 自动轮询同步函数 ============
  function getSavedPollInterval() {
    try {
      const saved = localStorage.getItem(pollConfigKey);
      if (saved) {
        const interval = parseInt(saved, 10);
        if (pollIntervalOptions.includes(interval)) return interval;
      }
    } catch (e) {}
    return defaultPollInterval;
  }

  function savePollInterval(interval) {
    try { localStorage.setItem(pollConfigKey, String(interval)); } catch (e) {}
  }

  function computeDataHash(items) {
    if (!items || !items.length) return '';
    return items.map(t => `${t.id}:${t.title}:${t.completed ? 1 : 0}:${t.pinned ? 1 : 0}:${t.content || ''}`).sort().join('|');
  }

  async function pollForUpdates() {
    if (document.hidden || !userId) return;
    try {
      const url = buildApiUrl() + '&_t=' + Date.now();
      const response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      if (!data || !data.items) return;
      const items = normalizeTodoCollection(data.items);
      const newHash = computeDataHash(items);
      if (lastDataHash && newHash !== lastDataHash) {
        todos = items;
        todos = sortTodos(todos);
        refreshRepeatingTodos();
        render();
      }
      lastDataHash = newHash;
    } catch (e) {}
  }

  function startPolling() {
    stopPolling();
    if (!currentPollInterval) currentPollInterval = getSavedPollInterval();
    if (currentPollInterval > 0) {
      lastDataHash = computeDataHash(todos);
      pollTimer = setInterval(pollForUpdates, currentPollInterval * 1000);
    }
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function updatePollInterval(interval) {
    currentPollInterval = interval;
    savePollInterval(interval);
    if (!document.hidden && userId) startPolling();
  }

  window.updatePollInterval = updatePollInterval;

  // Markdown渲染函数
  function renderMarkdown(text) {
    if (!text) return "";
    // 等待marked库加载
    if (typeof marked === 'undefined') return text;

    // 配置marked选项
    marked.setOptions({
      breaks: true, // 支持换行
      gfm: true, // GitHub风格Markdown
    });

    return marked.parse(text);
  }

  function resolveApiEndpoints() {
    const DEFAULT_BASE = "/todo";
    let scriptSegments = [];
    let locationSegments = [];

    const scriptEl =
      document.currentScript ||
      Array.from(document.querySelectorAll("script[src]")).find((el) =>
        el.src.includes("/todo/static/js/app.js")
      );

    if (scriptEl) {
      try {
        const srcUrl = new URL(scriptEl.src, window.location.origin);
        const pathSegments = srcUrl.pathname.split("/").filter(Boolean);
        const staticIndex = pathSegments.lastIndexOf("static");
        if (staticIndex > 0) {
          scriptSegments = pathSegments.slice(0, staticIndex);
        } else if (pathSegments.length) {
          const fallbackCount = Math.max(0, pathSegments.length - 3);
          scriptSegments = pathSegments.slice(0, fallbackCount);
        }
      } catch (error) {
        console.debug("[todo] Failed to derive API base from script", error);
      }
    }

    try {
      const pathname = window.location?.pathname || "";
      locationSegments = pathname.split("/").filter(Boolean);
    } catch (error) {
      console.debug("[todo] Unable to read location pathname", error);
      locationSegments = [];
    }

    let shared = 0;
    while (
      shared < scriptSegments.length &&
      shared < locationSegments.length &&
      scriptSegments[shared] === locationSegments[shared]
    ) {
      shared += 1;
    }

    let baseSegments = [];
    if (shared > 0) {
      baseSegments = scriptSegments.slice(0, shared);
    } else if (scriptSegments.length) {
      baseSegments = scriptSegments.slice();
    } else if (locationSegments.length) {
      baseSegments = locationSegments.slice();
    }

    let basePath = baseSegments.length ? `/${baseSegments.join("/")}` : DEFAULT_BASE;

    basePath = basePath.replace(/\/+$/, "");
    if (!basePath.startsWith("/")) {
      basePath = `/${basePath}`;
    }
    if (!basePath) {
      basePath = DEFAULT_BASE;
    }

    return {
      basePath,
      itemsEndpoint: `${basePath}/api/items`,
      registerEndpoint: `${basePath}/api/register`,
      loginEndpoint: `${basePath}/api/login`,
      profileEndpoint: `${basePath}/api/profile`,
      nicknameEndpoint: `${basePath}/api/nickname`,
      searchUserEndpoint: `${basePath}/api/user/search`,
    };
  }

  init().catch(error => {
    console.error('[todo] Initialization failed:', error);
  });

  // 更新重复提示
  function updateRepeatHints() {
    if (!repeatPresetSelect || !repeatHintWeekly || !repeatHintMonthly) return;

    let hours = 1;
    const presetValue = repeatPresetSelect.value;

    if (presetValue === 'custom') {
      hours = parseInt(repeatHoursInput.value) || 1;
    } else {
      hours = parseInt(presetValue) || 1;
    }

    const weeklyCount = Math.floor(168 / hours); // 一周168小时
    const monthlyCount = Math.floor(720 / hours); // 一月约720小时(30天)

    repeatHintWeekly.textContent = `每周 ${weeklyCount} 次`;
    repeatHintMonthly.textContent = `每月 ${monthlyCount} 次`;
  }

  // 获取当前重复小时数
  function getCurrentRepeatHours() {
    if (!repeatPresetSelect) return 1;

    const presetValue = repeatPresetSelect.value;
    if (presetValue === 'custom') {
      return parseInt(repeatHoursInput.value) || 1;
    } else {
      return parseInt(presetValue) || 1;
    }
  }

  async function init() {
    // 首先确保用户ID，不显示加载指示器（避免覆盖登录框）
    userId = await ensureUserId();
    window.userId = userId; // 暴露给share-revoke.js

    // 用户ID确认后，显示加载指示器开始加载数据
    document.body.classList.add('loading');
    const loadStartTime = Date.now();

    updateStorageKeys(userId);
    searchTerms = normalizeSearchTerms(searchInput ? searchInput.value : "");
    resetStartInputs();
    await hydrateData();
    todos = sortTodos(todos);
    const refreshed = refreshRepeatingTodos();
    if (refreshed) {
      todos = sortTodos(todos);
    }
    render();
    mountBackupControls(); // 新增：挂载 导出/导入 + 持久化指示
    initializeNicknameHandlers();  // 新增：初始化昵称相关处理器
    // setupMobileHeaderLayout(); // 已禁用：现在使用纯CSS控制布局

    // 监听窗口大小变化，响应式调整复选框位置
    window.addEventListener('resize', () => {
      setupMobileCheckboxes();
    });

    if (refreshed) {
      await saveTodos();
    }

    // 所有初始化完成后，加载用户昵称
    await loadUserProfile(userId);
    updateAllUserDisplays(); // 确保所有昵称显示都更新

    // 确保加载指示器至少显示600ms，让用户能看到动画
    const loadDuration = Date.now() - loadStartTime;
    const minDisplayTime = 600; // 最小显示时间：600ms
    if (loadDuration < minDisplayTime) {
      await new Promise(resolve => setTimeout(resolve, minDisplayTime - loadDuration));
    }

    // 移除加载指示器
    document.body.classList.remove('loading');

    // 启动自动轮询同步
    startPolling();
    const pollSelect = document.querySelector('#poll-interval-select');
    if (pollSelect) {
      pollSelect.value = String(getSavedPollInterval());
      pollSelect.addEventListener('change', e => updatePollInterval(parseInt(e.target.value, 10)));
    }

    titleInput.addEventListener("input", updateAddButtonState);
    contentInput.addEventListener("input", updateAddButtonState);
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        searchTerms = normalizeSearchTerms(searchInput.value);
        render();
      });
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const title = titleInput.value.trim();
      const content = contentInput.value.trim();
      if (!title) return;

      const startAt = getFormStartTimestamp();
      // 获取重复模式
      let repeatMode = "none";
      let repeatHours = 0;

      if (repeatDailyInput && repeatDailyInput.checked) {
        repeatMode = "daily";
        repeatHours = 24;
      } else if (repeatCustomInput && repeatCustomInput.checked) {
        repeatMode = "custom";
        repeatHours = getCurrentRepeatHours(); // 使用新函数获取小时数
      }

      const repeatDaily = repeatMode === "daily";
      const repeatConfig = {
        mode: repeatMode,
        hours: repeatHours
      };

      // 读取置顶选项
      const pinCheckbox = document.getElementById("todo-pin-new");
      const shouldPin = pinCheckbox ? pinCheckbox.checked : true; // 默认置顶

      todos.unshift(createTodo(title, content, startAt, repeatDaily, repeatConfig, shouldPin));
      titleInput.value = "";
      contentInput.value = "";
      resetStartInputs();
      updateAddButtonState();
      await saveAndRender();
      showAddSuccessToast("任务已成功添加");

      // 添加成功后折叠表单
      setFormVisibility(false);
    });

    if (todayLabel) {
      todayLabel.textContent = getTodayLabel();
    }

    if (formToggle) {
      formToggle.addEventListener("click", () => {
        const expanded = formToggle.getAttribute("aria-expanded") === "true";
        setFormVisibility(!expanded);
      });
    }

    // 循环筛选按钮
    if (filterCycleBtn) {
      const filterCycleOrder = ["all", "active", "completed"];
      const filterCycleLabels = { all: "全部", active: "进行", completed: "完成" };

      filterCycleBtn.addEventListener("click", () => {
        const currentIndex = filterCycleOrder.indexOf(activeFilter);
        const nextIndex = (currentIndex + 1) % filterCycleOrder.length;
        activeFilter = filterCycleOrder[nextIndex];
        filterCycleBtn.textContent = filterCycleLabels[activeFilter];
        render();
      });
    }

    // 显示/隐藏已完成按钮 (H-A循环)
    if (showCompletedBtn) {
      // 初始化按钮状态
      showCompletedBtn.textContent = showCompleted ? "A" : "H";

      showCompletedBtn.addEventListener("click", () => {
        showCompleted = !showCompleted;
        preferences.showCompleted = showCompleted;
        savePreferences();
        showCompletedBtn.textContent = showCompleted ? "A" : "H";
        render();
      });
    }

    // 折叠/展开头部内容
    const headerCollapseBtn = document.querySelector("#header-collapse-toggle");
    const collapsibleContent = document.querySelector("#collapsible-content");
    const collapsibleControls = document.querySelector("#collapsible-controls");
    const titleRow = document.querySelector(".title-row");
    const todoPanel = document.querySelector(".todo-panel");

    // 将toggleCollapse提升到外部作用域，以便自动折叠功能可以访问
    let toggleCollapse = null;

    // 禁止标题栏双击放大（更强的方法）
    if (titleRow) {
      let lastTouchEnd = 0;

      // 阻止双击事件
      titleRow.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
      }, { passive: false });

      // 阻止快速双击（移动端更有效）
      titleRow.addEventListener("touchend", (e) => {
        const now = Date.now();
        if (now - lastTouchEnd <= 300) {
          e.preventDefault();
          e.stopPropagation();
        }
        lastTouchEnd = now;
      }, { passive: false });

      // 禁止标题文字双击
      const titleH1 = titleRow.querySelector("h1");
      if (titleH1) {
        let h1LastTouchEnd = 0;

        titleH1.addEventListener("dblclick", (e) => {
          e.preventDefault();
          e.stopPropagation();
        }, { passive: false });

        titleH1.addEventListener("touchend", (e) => {
          const now = Date.now();
          if (now - h1LastTouchEnd <= 300) {
            e.preventDefault();
            e.stopPropagation();
          }
          h1LastTouchEnd = now;
        }, { passive: false });
      }
    }

    if (headerCollapseBtn && collapsibleContent && collapsibleControls) {
      // 折叠/展开的核心逻辑函数 - 赋值给外部变量
      toggleCollapse = () => {
        const isCollapsed = headerCollapseBtn.classList.contains("collapsed");

        if (isCollapsed) {
          // 展开 - 先滚动到顶部，再展开内容
          window.scrollTo({ top: 0, behavior: 'smooth' });

          // 延迟展开，等待滚动动画
          setTimeout(() => {
            headerCollapseBtn.classList.remove("collapsed");
            collapsibleContent.classList.remove("collapsed");
            collapsibleControls.classList.remove("collapsed");
            // 恢复标题栏和面板原始位置
            if (titleRow) titleRow.style.top = "";
            if (todoPanel) todoPanel.style.marginTop = "";
          }, 300);
        } else {
          // 折叠 - 先滚动到顶部，再折叠内容
          window.scrollTo({ top: 0, behavior: 'smooth' });

          // 延迟折叠，等待滚动动画
          setTimeout(() => {
            headerCollapseBtn.classList.add("collapsed");
            collapsibleContent.classList.add("collapsed");
            collapsibleControls.classList.add("collapsed");
            // 折叠时设置负margin，压缩空白
            const isMobile = window.innerWidth <= 720;
            const isSmallMobile = window.innerWidth <= 420;

            if (titleRow) {
              if (isSmallMobile) {
                titleRow.style.top = '-1.7rem';
              } else if (isMobile) {
                titleRow.style.top = '-2.2rem';
              } else {
                titleRow.style.top = '-2.5rem';
              }
            }
            if (todoPanel) {
              if (isSmallMobile) {
                todoPanel.style.marginTop = '-1.7rem';
              } else if (isMobile) {
                todoPanel.style.marginTop = '-2.2rem';
              } else {
                todoPanel.style.marginTop = '-2.5rem';
              }
            }
          }, 300);
        }
      };

      // 按钮点击事件
      headerCollapseBtn.addEventListener("click", (e) => {
        e.stopPropagation(); // 防止冒泡到 title-row
        toggleCollapse();
      });

      // 整个标题栏点击事件
      if (titleRow) {
        titleRow.addEventListener("click", (e) => {
          // 如果点击的是按钮本身，不处理（已经由按钮事件处理）
          if (e.target.closest("#header-collapse-toggle")) {
            return;
          }
          toggleCollapse();
        });

        // 添加鼠标悬停提示
        titleRow.style.cursor = "pointer";
        titleRow.title = "点击展开/收缩";
      }

      // 初始化为折叠状态
      headerCollapseBtn.classList.add("collapsed");
      collapsibleContent.classList.add("collapsed");
      collapsibleControls.classList.add("collapsed");
      // 初始化折叠状态的位置
      const initIsMobile = window.innerWidth <= 720;
      const initIsSmallMobile = window.innerWidth <= 420;
      if (titleRow) {
        if (initIsSmallMobile) {
          titleRow.style.top = '-1.7rem';
        } else if (initIsMobile) {
          titleRow.style.top = '-2.2rem';
        } else {
          titleRow.style.top = '-2.5rem';
        }
      }
      if (todoPanel) {
        if (initIsSmallMobile) {
          todoPanel.style.marginTop = '-1.7rem';
        } else if (initIsMobile) {
          todoPanel.style.marginTop = '-2.2rem';
        } else {
          todoPanel.style.marginTop = '-2.5rem';
        }
      }
    }

    // ==================== 自动折叠功能 ====================
    const autoCollapseEnable = document.getElementById("auto-collapse-enable");
    const autoCollapseSeconds = document.getElementById("auto-collapse-seconds");
    const autoCollapseApplyBtn = document.getElementById("auto-collapse-apply");
    let autoCollapseTimer = null;

    // 从localStorage加载设置，如果没有保存过，默认为true（启用）
    const savedAutoCollapse = localStorage.getItem("autoCollapseEnabled");
    const isAutoCollapseEnabled = savedAutoCollapse === null ? true : savedAutoCollapse === "true";
    const savedSeconds = localStorage.getItem("autoCollapseSeconds") || "5";

    if (autoCollapseEnable) {
      autoCollapseEnable.checked = isAutoCollapseEnabled;
      autoCollapseSeconds.disabled = !isAutoCollapseEnabled;
      autoCollapseApplyBtn.disabled = !isAutoCollapseEnabled;
      autoCollapseSeconds.value = savedSeconds;

      // 如果是首次使用（没有保存过设置），保存默认值
      if (savedAutoCollapse === null) {
        localStorage.setItem("autoCollapseEnabled", "true");
      }
    }

    // 启动自动折叠定时器
    function startAutoCollapseTimer() {
      if (autoCollapseTimer) {
        clearTimeout(autoCollapseTimer);
        autoCollapseTimer = null;
      }

      const isEnabled = autoCollapseEnable?.checked;
      const seconds = parseInt(autoCollapseSeconds?.value || "5");
      const isCollapsed = headerCollapseBtn?.classList.contains("collapsed");

      // 只有在启用且当前是展开状态时才设置定时器
      if (isEnabled && !isCollapsed) {
        autoCollapseTimer = setTimeout(() => {
          // 自动折叠
          if (headerCollapseBtn && !headerCollapseBtn.classList.contains("collapsed")) {
            toggleCollapse();
          }
        }, seconds * 1000);
      }
    }

    // 全局点击事件监听 - 重置自动折叠计时器
    document.addEventListener("click", (e) => {
      // 只有在自动折叠启用且头部展开时才重置计时器
      const isEnabled = autoCollapseEnable?.checked;
      const isCollapsed = headerCollapseBtn?.classList.contains("collapsed");

      if (isEnabled && !isCollapsed) {
        // 重置计时器
        startAutoCollapseTimer();
      }
    }, true); // 使用捕获阶段确保能捕获所有点击

    // 全局触摸事件监听 - 重置自动折叠计时器（手机端滑动）
    document.addEventListener("touchstart", (e) => {
      const isEnabled = autoCollapseEnable?.checked;
      const isCollapsed = headerCollapseBtn?.classList.contains("collapsed");

      if (isEnabled && !isCollapsed) {
        startAutoCollapseTimer();
      }
    }, true);

    document.addEventListener("touchmove", (e) => {
      const isEnabled = autoCollapseEnable?.checked;
      const isCollapsed = headerCollapseBtn?.classList.contains("collapsed");

      if (isEnabled && !isCollapsed) {
        startAutoCollapseTimer();
      }
    }, true);


    // 全局键盘输入事件监听 - 重置自动折叠计时器（用户打字时）
    document.addEventListener("input", (e) => {
      const isEnabled = autoCollapseEnable?.checked;
      const isCollapsed = headerCollapseBtn?.classList.contains("collapsed");

      if (isEnabled && !isCollapsed) {
        startAutoCollapseTimer();
      }
    }, true);

    // 全局键盘按键事件监听 - 重置自动折叠计时器（键盘操作）
    document.addEventListener("keydown", (e) => {
      const isEnabled = autoCollapseEnable?.checked;
      const isCollapsed = headerCollapseBtn?.classList.contains("collapsed");

      if (isEnabled && !isCollapsed) {
        startAutoCollapseTimer();
      }
    }, true);

    // 全局焦点事件监听 - 重置自动折叠计时器（输入框获得焦点）
    document.addEventListener("focus", (e) => {
      const isEnabled = autoCollapseEnable?.checked;
      const isCollapsed = headerCollapseBtn?.classList.contains("collapsed");

      if (isEnabled && !isCollapsed) {
        startAutoCollapseTimer();
      }
    }, true);

    // 全局滚动事件监听 - 重置自动折叠计时器（滚动屏幕）
    document.addEventListener("scroll", (e) => {
      const isEnabled = autoCollapseEnable?.checked;
      const isCollapsed = headerCollapseBtn?.classList.contains("collapsed");

      if (isEnabled && !isCollapsed) {
        startAutoCollapseTimer();
      }
    }, true);
    // 复选框change事件
    if (autoCollapseEnable) {
      autoCollapseEnable.addEventListener("change", (e) => {
        const isEnabled = e.target.checked;
        autoCollapseSeconds.disabled = !isEnabled;
        autoCollapseApplyBtn.disabled = !isEnabled;

        // 保存到localStorage
        localStorage.setItem("autoCollapseEnabled", isEnabled);

        // 启动或停止定时器
        if (!isEnabled) {
          if (autoCollapseTimer) {
            clearTimeout(autoCollapseTimer);
            autoCollapseTimer = null;
          }
          // 取消勾选时，应用按钮显示反馈
          if (autoCollapseApplyBtn) {
            autoCollapseApplyBtn.style.background = 'linear-gradient(135deg, #ef5f7a, #d94965)';
            autoCollapseApplyBtn.style.borderColor = '#ef5f7a';
            autoCollapseApplyBtn.textContent = '✓ 已取消';
            setTimeout(() => {
              autoCollapseApplyBtn.style.background = 'linear-gradient(135deg, var(--primary), var(--primary-dark))';
              autoCollapseApplyBtn.style.borderColor = 'var(--primary)';
              autoCollapseApplyBtn.textContent = '应用';
            }, 2000);
          }
        }
      });
    }

    // 下拉框change事件
    if (autoCollapseSeconds) {
      autoCollapseSeconds.addEventListener("change", (e) => {
        const seconds = e.target.value;
        // 保存到localStorage
        localStorage.setItem("autoCollapseSeconds", seconds);

        // 如果已启用，提示用户点击应用按钮
        if (autoCollapseEnable?.checked && autoCollapseApplyBtn) {
          // 按钮闪烁提示
          autoCollapseApplyBtn.style.animation = 'pulse 0.5s ease-in-out 2';
          setTimeout(() => {
            autoCollapseApplyBtn.style.animation = '';
          }, 1000);
        }
      });
    }

    // 应用按钮点击事件
    if (autoCollapseApplyBtn) {
      autoCollapseApplyBtn.addEventListener("click", () => {
        // 立即启动定时器
        const isEnabled = autoCollapseEnable?.checked;
        if (isEnabled) {
          startAutoCollapseTimer();

          // 更改按钮颜色表示已应用
          autoCollapseApplyBtn.style.background = 'linear-gradient(135deg, #38c985, #2da872)';
          autoCollapseApplyBtn.style.borderColor = '#38c985';
          autoCollapseApplyBtn.textContent = '✓ 已应用';

          // 2秒后恢复原样
          setTimeout(() => {
            autoCollapseApplyBtn.style.background = 'linear-gradient(135deg, var(--primary), var(--primary-dark))';
            autoCollapseApplyBtn.style.borderColor = 'var(--primary)';
            autoCollapseApplyBtn.textContent = '应用';
          }, 2000);
        }
      });
    }

    // 监听展开事件，启动定时器
    if (headerCollapseBtn) {
      // 使用事件委托，在点击后检查状态
      const checkAndStartTimer = () => {
        setTimeout(() => {
          const isCollapsed = headerCollapseBtn.classList.contains("collapsed");
          if (!isCollapsed) {
            // 展开了，如果启用了自动折叠则启动定时器
            if (autoCollapseEnable?.checked) {
              startAutoCollapseTimer();
            }
          } else {
            // 折叠了，清除定时器
            if (autoCollapseTimer) {
              clearTimeout(autoCollapseTimer);
              autoCollapseTimer = null;
            }
          }
        }, 700);  // 增加延迟到700ms，确保折叠动画(300ms)完成后再检查
      };

      // 原有的按钮点击事件已经存在，我们添加额外的监听
      const originalToggleHandler = headerCollapseBtn.onclick;
      headerCollapseBtn.addEventListener("click", checkAndStartTimer);

      // 标题栏点击也要处理
      if (titleRow) {
        // 使用捕获阶段，确保能够监听到
        titleRow.addEventListener("click", (e) => {
          // 排除点击按钮本身的情况
          if (!e.target.closest("#header-collapse-toggle")) {
            checkAndStartTimer();
          }
        });
      }
    }

    // 重复模式切换逻辑
    const repeatModeInputs = document.querySelectorAll('input[name="repeat-mode"]');
    repeatModeInputs.forEach(input => {
      input.addEventListener("change", () => {
        if (customRepeatPanel) {
          customRepeatPanel.hidden = input.value !== "custom";
          if (input.value === "custom") {
            updateRepeatHints(); // 切换到自定义时更新提示
          }
        }
      });
    });

    // 下拉菜单切换逻辑
    if (repeatPresetSelect) {
      repeatPresetSelect.addEventListener("change", () => {
        const isCustom = repeatPresetSelect.value === "custom";
        if (customHoursField) {
          customHoursField.hidden = !isCustom;
        }
        if (repeatHoursInput) {
          repeatHoursInput.disabled = !isCustom;
        }
        updateRepeatHints();
      });
    }

    // 自定义重复小时数变化时更新提示
    if (repeatHoursInput) {
      repeatHoursInput.addEventListener("input", updateRepeatHints);
    }

    // 初始化提示
    updateRepeatHints();

    // 初始化自定义小时数输入框状态
    if (repeatPresetSelect && repeatHoursInput) {
      repeatHoursInput.disabled = repeatPresetSelect.value !== "custom";
    }

    // 刷新按钮事件监听器 - 使用当前用户ID重新登录载入
    if (refreshBtn) {
      refreshBtn.addEventListener("click", async () => {
        if (refreshBtn.classList.contains("refreshing")) {
          return; // 防止重复点击
        }

        // 显示全局加载指示器
        document.body.classList.add("loading");
        const refreshStartTime = Date.now();

        // 添加加载状态
        refreshBtn.classList.add("refreshing");
        const originalText = refreshBtn.textContent;
        refreshBtn.textContent = "重新载入中...";

        try {
          // 保留当前用户ID
          const currentUserId = userId;

          // 清空当前数据
          todos = [];
          todoList.innerHTML = "";

          // 使用当前用户ID重新加载数据
          await hydrateData();
          todos = sortTodos(todos);
          const refreshed = refreshRepeatingTodos();
          if (refreshed) {
            todos = sortTodos(todos);
            await saveTodos();
          }
          render();

        } catch (error) {
          console.error("[todo] 重新载入出错", error);
        } finally {
          // 确保加载指示器至少显示500ms
          const refreshDuration = Date.now() - refreshStartTime;
          const minDisplayTime = 500;
          if (refreshDuration < minDisplayTime) {
            await new Promise(resolve => setTimeout(resolve, minDisplayTime - refreshDuration));
          }

          // 恢复按钮状态
          refreshBtn.classList.remove("refreshing");
          refreshBtn.textContent = originalText;

          // 移除全局加载指示器
          document.body.classList.remove("loading");
        }
      });
    }

    // 取消按钮：清空表单并折叠
    if (formCancelButton) {
      formCancelButton.addEventListener("click", () => {
        // 清空表单输入
        titleInput.value = "";
        contentInput.value = "";
        resetStartInputs();
        updateAddButtonState();

        // 折叠表单
        setFormVisibility(false);
      });
    }

    todoList.addEventListener("change", async (event) => {
      const target = event.target;

      // 处理置顶开关
      if (target.classList.contains("todo-pin")) {
        const listItem = target.closest(".todo-item");
        if (!listItem) return;
        const id = listItem.dataset.id;
        await togglePin(id, target.checked);
        return;
      }

      if (!target.classList.contains("todo-toggle")) return;
      const listItem = target.closest(".todo-item");
      if (!listItem) return;
      const id = listItem.dataset.id;
      await toggleTodo(id, target.checked);
    });

    todoList.addEventListener("click", async (event) => {
      // 处理 custom-checkbox 点击（因为改用 div 而非 label）
      const customCheckbox = event.target.closest(".custom-checkbox");
      if (customCheckbox) {
        const checkbox = customCheckbox.parentElement.querySelector(".todo-toggle");
        if (checkbox) {
          checkbox.checked = !checkbox.checked;
          checkbox.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return;
      }

      const deleteButton = event.target.closest(".delete-btn");
      if (deleteButton) {
        const id = deleteButton.closest(".todo-item")?.dataset.id;
        if (id) {
          const todo = todos.find((item) => item.id === id);
          const result = await showDeleteConfirmDialog(todo);
          if (!result.confirmed) return;
          await deleteTodo(id, result.deleteFiles);
        }
        return;
      }

      // 复制分享按钮（已废弃，功能集成到分享按钮）
      const copyShareButton = event.target.closest(".copy-share-btn");
      if (copyShareButton) {
        const id = copyShareButton.closest(".todo-item")?.dataset.id;
        if (id) {
          const todo = todos.find((item) => item.id === id);
          if (todo) {
            await copyTaskToClipboard(todo);
          }
        }
        return;
      }

      const shareButton = event.target.closest(".share-btn");
      if (shareButton) {
        event.stopPropagation();
        const id = shareButton.closest(".todo-item")?.dataset.id;
        if (id) {
          const todo = todos.find((item) => item.id === id);
          if (todo) {
            openShareChoiceMenu(todo, shareButton);
          }
        }
        return;
      }

      const editButton = event.target.closest(".edit-btn");
      if (editButton) {
        const item = editButton.closest(".todo-item");
        if (item) startEdit(item);
        return;
      }

      // 字体大小切换按钮
		// 字体大小循环按钮：中 → 大 → 小 → 中 → ...
		const fontSizeBtn = event.target.closest(".font-size-btn");
		if (fontSizeBtn) {
		  const todoItem = fontSizeBtn.closest(".todo-item");
		  if (!todoItem) return;

		  const contentEl = todoItem.querySelector(".todo-content");
		  if (!contentEl) return;

		  // 循环顺序
		  const order = ["medium", "large", "small"];

		  // 当前大小，从 data-size 读取，默认 medium
		  const currentSize = fontSizeBtn.dataset.size || "medium";
		  let idx = order.indexOf(currentSize);
		  if (idx === -1) idx = 0;

		  // 下一个大小
		  const nextSize = order[(idx + 1) % order.length];

		  // 更新按钮的 data-size 与文字
		  fontSizeBtn.dataset.size = nextSize;
		  fontSizeBtn.textContent =
			nextSize === "small" ? "小" :
			nextSize === "medium" ? "中" : "大";

		  // 更新内容区域的字体类
		  contentEl.classList.remove("font-small", "font-medium", "font-large");
		  contentEl.classList.add(`font-${nextSize}`);

		  // 保持按钮高亮
		  fontSizeBtn.classList.add("active");

		  return;
		}

      // 行顺序切换按钮
		// 行顺序循环按钮：下(正序) → 上(倒序) → ...
		const lineOrderBtn = event.target.closest(".line-order-btn");
		if (lineOrderBtn) {
		  const todoItem = lineOrderBtn.closest(".todo-item");
		  if (!todoItem) return;

		  const contentEl = todoItem.querySelector(".todo-content");
		  if (!contentEl) return;

		  // 循环顺序
		  const orderList = ["normal", "reverse"];

		  // 当前值
		  const current = lineOrderBtn.dataset.order || "normal";
		  const next = current === "normal" ? "reverse" : "normal";

		  // 更新按钮文字
		  lineOrderBtn.textContent = next === "normal" ? "↓" : "↑";

		  // 更新 data-order
		  lineOrderBtn.dataset.order = next;

		  // 获取原始 Markdown
		  const originalMarkdown =
			contentEl.getAttribute("data-original-markdown") ||
			contentEl.getAttribute("data-original-content") ||
			"";

		  const lines = originalMarkdown.split("\n");
		  const reordered =
			next === "reverse" ? [...lines].reverse() : lines;

		  contentEl.innerHTML = renderMarkdown(reordered.join("\n"));

		  // 保存用户偏好（仍然兼容旧机制）
		  const itemId = todoItem.dataset.id;
		  const lineOrderPrefs = JSON.parse(localStorage.getItem("lineOrderPrefs") || "{}");
		  lineOrderPrefs[itemId] = next;
		  localStorage.setItem("lineOrderPrefs", JSON.stringify(lineOrderPrefs));

		  return;
		}


      // 全屏切换按钮
      const fullscreenBtn = event.target.closest(".fullscreen-toggle-btn");
      if (fullscreenBtn) {
        const todoItem = fullscreenBtn.closest(".todo-item");
        const contentEl = todoItem.querySelector(".todo-content");

        // 获取所有全屏按钮（顶部和底部）
        const allFullscreenBtns = todoItem.querySelectorAll(".fullscreen-toggle-btn");

        // 切换全屏状态
        if (contentEl.classList.contains("fullscreen-content")) {
          // 退出全屏模式
          contentEl.classList.remove("fullscreen-content");
          // 同步更新所有按钮
          allFullscreenBtns.forEach(btn => {
            btn.textContent = "⛶";  // 展开图标
            btn.title = "全屏显示";
          });
        } else {
          // 进入全屏模式
          contentEl.classList.add("fullscreen-content");
          // 同步更新所有按钮
          allFullscreenBtns.forEach(btn => {
            btn.textContent = "⊡";  // 收缩图标
            btn.title = "退出全屏";
          });
        }

        return;
      }
    });

    filters.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-filter]");
      if (!button) return;
      activeFilter = button.dataset.filter;
      render();
    });

    if (secondaryActionBtn) {
      secondaryActionBtn.addEventListener("click", async () => {
        if (activeFilter === "all") {
          showCompleted = !showCompleted;
          preferences.showCompleted = showCompleted;
          savePreferences();
          render();
          return;
        }
        if (activeFilter === "completed") {
          const completedCount = todos.filter((todo) => todo.completed).length;
          if (completedCount === 0) {
            return;
          }

          // 添加用户确认提示
          const confirmed = window.confirm(
            `确认清除全部 ${completedCount} 个已完成任务吗？此操作无法恢复。`
          );

          if (!confirmed) {
            return;
          }

          const next = todos.filter((todo) => !todo.completed);
          if (next.length !== todos.length) {
            todos = next;
            await saveAndRender();
          }
        }
      });
    }

  // 跨标签页同步
  window.addEventListener("storage", async (event) => {
    if (event.key === storageKey) {
      todos = await loadTodosFromCaches();
      render();
    } else if (event.key === preferenceKey) {
      preferences = loadPreferences();
      showCompleted = preferences.showCompleted ?? defaultPreferences.showCompleted;
      render();
    }
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  if (userId) {
    await loadUserProfile(userId);
    updateAllUserDisplays(); // 确保更新所有显示
  }
});

// 页面可见性变化时处理轮询和数据同步
document.addEventListener("visibilitychange", async () => {
  if (document.hidden) {
    stopPolling();
  } else if (userId) {
    try {
      await pollForUpdates();
      await loadUserProfile(userId);
      updateAllUserDisplays();
      startPolling();
    } catch (e) {}
  }
});

// 申请持久化存储，降低被系统清理的概率
ensurePersistentStorage().then((ok) => {
  persistedStatus = !!ok;
  setPersistIndicator(persistedStatus);
}).catch(error => {
  console.debug("[todo] Persistent storage request failed:", error);
  setPersistIndicator(false);
});

  async function hydrateData() {
    const serverPayload = await fetchServerPayload();
    if (serverPayload) {
      todos = serverPayload.items;
      preferences = serverPayload.preferences;
      showCompleted = preferences.showCompleted ?? defaultPreferences.showCompleted;
      const serialized = serializeTodos(todos);
      saveToLocalStoragePayload(serialized);
      persistPreferencesLocal(preferences);

      // 优化：延迟 IndexedDB 写入，不阻塞 UI 渲染
      setTimeout(async () => {
        try {
          const db = await dbPromise;
          if (db) await writeAllToIndexedDB(db, serialized);
        } catch (error) {
          console.debug("[todo] Prefill IndexedDB failed", error);
        }
      }, 0);
    } else {
      todos = await loadTodosFromCaches();
      preferences = loadPreferences();
      showCompleted = preferences.showCompleted ?? defaultPreferences.showCompleted;
      persistPreferencesLocal(preferences);
    }
  }

  // ----------------------- 业务函数 -----------------------
  function createTodo(title, content, startAt, repeatDaily = false, repeatConfig = null, pinned = true) {
    const now = Date.now();
    const startTimestamp = normalizeTimestamp(startAt) ?? now;
    return {
      id: crypto.randomUUID ? crypto.randomUUID() : String(now + Math.random()),
      title,
      content,
      completed: false,
      pinned: !!pinned,              // 使用传入的pinned参数，默认true
      startAt: startTimestamp,
      repeatDaily: !!repeatDaily,
      createdAt: now,
      updatedAt: now,
    };
  }

  function touch(todo) {
    todo.updatedAt = Date.now();
  }

  async function toggleTodo(id, completed) {
    const todo = todos.find((item) => item.id === id);
    if (!todo) return;
    todo.completed = completed;
    touch(todo);
    await saveAndRender();
  }

  async function togglePin(id, pinned) {
    const todo = todos.find((item) => item.id === id);
    if (!todo) return;
    todo.pinned = pinned;
    touch(todo);
    await saveAndRender();
  }

  async function deleteTodo(id, deleteFiles = false) {
    const todoToDelete = todos.find((item) => item.id === id);
    if (!todoToDelete) return;

    // 协作任务需要调用专门的API
    if (todoToDelete.isCollaborative) {
      try {
        const response = await fetch(`${apiEndpoint.replace('/items', '/collaborate')}/${id}?user_id=${userId}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await response.json();
        if (!response.ok) {
          showToast(data.msg || '删除协作任务失败', 'error');
          return;
        }
        showToast(data.msg || '已退出协作任务');
      } catch (e) {
        console.error('[todo] 删除协作任务失败:', e);
        showToast('删除协作任务失败', 'error');
        return;
      }
    }

    const next = todos.filter((item) => item.id !== id);

    // 删除任务的分享历史（防止history.json无限增长）
    if (typeof window.deleteShareHistory === 'function') {
      try {
        await window.deleteShareHistory(id);
      } catch (error) {
        console.warn(`[todo] Failed to delete share history for task ${id}:`, error);
      }
    }

    // 删除任务关联的附件引用（后端处理）- 仅对非协作任务
    if (!todoToDelete.isCollaborative) {
      try {
        const response = await fetch(`/todo/api/todos/${id}/attachments/cleanup?user_id=${userId}&delete_files=${deleteFiles}`, {
          method: 'DELETE'
        });
        if (!response.ok) {
          console.warn(`[todo] Failed to cleanup attachments for task ${id}`);
        }
      } catch (error) {
        console.warn(`[todo] Failed to cleanup attachments for task ${id}:`, error);
      }
    }

    todos = next;
    await saveAndRender();
  }

  // ============================================
  // 复制分享功能（微信等外部分享）
  // ============================================

  /**
   * 格式化任务内容用于分享
   */
  function formatTaskForShare(todo) {
    const lines = [];

    // 标题
    lines.push(`📋 ${todo.title}`);
    lines.push('');

    // 内容
    if (todo.content && todo.content.trim()) {
      lines.push(todo.content.trim());
      lines.push('');
    }

    // 开始时间
    if (todo.startAt) {
      const startDate = new Date(todo.startAt);
      const dateStr = startDate.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
      lines.push(`⏰ 开始时间：${dateStr}`);
    }

    // 重复信息
    if (todo.repeatConfig && todo.repeatConfig.mode !== 'none') {
      if (todo.repeatConfig.mode === 'daily') {
        lines.push('🔄 重复：每日重复');
      } else if (todo.repeatConfig.mode === 'custom') {
        const hours = todo.repeatConfig.hours;
        if (hours === 168) {
          lines.push('🔄 重复：每周重复');
        } else if (hours === 720) {
          lines.push('🔄 重复：每月重复');
        } else {
          lines.push(`🔄 重复：每${hours}小时`);
        }
      }
    }

    // 签名
    lines.push('');
    lines.push('━━━━━━━━━━━━');
    lines.push('📤 来自 Sofia 记事清单');

    return lines.join('\n');
  }

  /**
   * 显示提示消息（通用Toast）
   */
  function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: ${type === 'success' ? '#38c985' : type === 'error' ? '#ef5f7a' : '#5146ff'};
      color: white;
      padding: 12px 24px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 10000;
      animation: slideDown 0.3s ease;
      font-weight: 500;
      max-width: 90%;
      text-align: center;
    `;

    // 添加动画样式
    if (!document.getElementById('toast-animations')) {
      const style = document.createElement('style');
      style.id = 'toast-animations';
      style.textContent = `
        @keyframes slideDown {
          from {
            opacity: 0;
            transform: translateX(-50%) translateY(-20px);
          }
          to {
            opacity: 1;
            transform: translateX(-50%) translateY(0);
          }
        }
        @keyframes slideUp {
          from {
            opacity: 1;
            transform: translateX(-50%) translateY(0);
          }
          to {
            opacity: 0;
            transform: translateX(-50%) translateY(-20px);
          }
        }
      `;
      document.head.appendChild(style);
    }

    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'slideUp 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  /**
   * 复制任务内容到剪贴板
   */
  async function copyTaskToClipboard(todo) {
    try {
      const shareText = formatTaskForShare(todo);

      // 现代浏览器使用 Clipboard API
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(shareText);
        showToast('✅ 已复制到剪贴板，可粘贴到微信分享', 'success');
      } else {
        // 降级方案：使用传统方法
        const textarea = document.createElement('textarea');
        textarea.value = shareText;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        textarea.setSelectionRange(0, textarea.value.length);

        const successful = document.execCommand('copy');
        document.body.removeChild(textarea);

        if (successful) {
          showToast('✅ 已复制到剪贴板，可粘贴到微信分享', 'success');
        } else {
          throw new Error('复制失败');
        }
      }
    } catch (error) {
      console.error('[todo] Copy failed:', error);
      showToast('❌ 复制失败，请手动选择文本复制', 'error');
    }
  }

  // 分享功能
  let currentShareTodo = null;
  let currentShareButton = null; // 保存当前点击的分享按钮

  /**
   * 打开分享方式选择菜单（在按钮附近）
   */
  function openShareChoiceMenu(todo, buttonElement) {
    currentShareTodo = todo;
    currentShareButton = buttonElement;
    window.currentShareTodo = todo;

    if (shareChoiceMenu && buttonElement) {
      const rect = buttonElement.getBoundingClientRect();

      setTimeout(() => {
        shareChoiceMenu.removeAttribute('hidden');
        shareChoiceMenu.style.display = 'block';
        shareChoiceMenu.style.position = 'fixed';
        shareChoiceMenu.style.zIndex = '99999';
        shareChoiceMenu.style.top = `${rect.bottom + 5}px`;
        shareChoiceMenu.style.left = `${rect.left}px`;
      }, 10);
    }
  }

  /**
   * 关闭分享方式选择菜单
   */
  function closeShareChoiceMenu() {
    if (shareChoiceMenu) {
      shareChoiceMenu.setAttribute('hidden', '');
      shareChoiceMenu.style.display = 'none';
    }
    currentShareTodo = null;
    currentShareButton = null;
  }

  /**
   * 打开分享对话框（应用内分享）
   */
  async function openShareDialog(todo) {
    currentShareTodo = todo;
    window.currentShareTodo = todo; // 暴露给share-revoke.js
    selectedUsers = [];
    shareTargetUser.value = "";
    shareError.hidden = true;

    // 加载所有用户列表
    await loadAllUsers();

    // 渲染已选择的用户
    renderSelectedUsers();

    // 检查并显示分享历史
    if (typeof window.checkAndShowShareHistory === 'function' && todo && todo.id) {
      window.checkAndShowShareHistory(todo.id);
    }
    // 显示对话框
    shareOverlay.hidden = false;
    shareTargetUser.focus();
  }

  /**
   * 关闭分享对话框
   */
  function closeShareDialog() {
    currentShareTodo = null;
    selectedUsers = [];
    allUsersList = [];
    shareOverlay.hidden = true;
    if (userDropdown) userDropdown.hidden = true;

    // 重置进度条
    const progressContainer = document.getElementById('share-progress-container');
    if (progressContainer) {
      progressContainer.hidden = true;
    }
  }

  /**
   * 处理广播分享（带进度条）
   */
  async function handleBroadcastShare(todo) {

    const progressContainer = document.getElementById('share-progress-container');
    const progressBar = document.getElementById('share-progress-bar');
    const progressCount = document.getElementById('share-progress-count');
    const progressStatus = document.getElementById('share-progress-status');
    const submitBtn = document.getElementById('share-submit-btn');
    const shareTargetInput = document.getElementById('share-target-user');

    console.log('[todo] Progress elements found:', {
      progressContainer: !!progressContainer,
      progressBar: !!progressBar,
      progressCount: !!progressCount,
      progressStatus: !!progressStatus,
      submitBtn: !!submitBtn,
      shareTargetInput: !!shareTargetInput
    });

    if (!progressContainer || !progressBar || !progressCount || !progressStatus) {
      console.error('[todo] Progress elements not found - missing:', {
        progressContainer: !progressContainer,
        progressBar: !progressBar,
        progressCount: !progressCount,
        progressStatus: !progressStatus
      });
      alert('错误：进度条元素未找到，请刷新页面后重试');
      return;
    }

    try {
      // 禁用按钮和输入框
      if (submitBtn) submitBtn.disabled = true;
      if (shareTargetInput) shareTargetInput.disabled = true;
      if (shareError) shareError.hidden = true;

      // 显示进度条
      progressContainer.hidden = false;
      progressBar.style.width = '0%';
      progressBar.classList.remove('complete');
      progressStatus.classList.remove('complete', 'error');
      progressStatus.textContent = '正在获取用户列表...';
      progressCount.textContent = '0 / 0';

      // 获取所有用户列表（除自己外）
      const allUsers = allUsersList.length > 0 ? allUsersList : await loadAllUsers();

      if (!allUsers || !Array.isArray(allUsers)) {
        throw new Error('获取用户列表失败');
      }

      const targetUsers = allUsers.filter(user => user.user_id !== userId);

      if (targetUsers.length === 0) {
        progressStatus.textContent = '没有可分享的用户';
        progressStatus.classList.add('error');
        if (submitBtn) submitBtn.disabled = false;
        if (shareTargetInput) shareTargetInput.disabled = false;
        return;
      }

      const totalCount = targetUsers.length;
      let successCount = 0;
      let failedCount = 0;
      const failedList = [];
      const successRecords = []; // 保存成功的分享记录

      progressStatus.textContent = `准备分享给 ${totalCount} 个用户...`;
      progressCount.textContent = `0 / ${totalCount}`;

      // 获取署名选项
      const signatureRadio = document.querySelector('input[name="share-signature"]:checked');
      const isSigned = signatureRadio ? signatureRadio.value === 'signed' : true; // 默认署名

      // 逐个分享，更新进度
      for (let i = 0; i < targetUsers.length; i++) {
        const user = targetUsers[i];
        const progress = ((i + 1) / totalCount) * 100;

        try {
          // 发送分享请求
          const response = await fetch(`${apiEndpoint}/share`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              target_users: [user.user_id],
              todo: todo,
              signed: isSigned,  // ← 新增：署名标识
              from_nickname: isSigned ? userNickname : null,  // ← 只在署名时发送昵称
              source_user_id: userId  // u2190 u65b0u589euff1au5206u4eabu8005u7684user_iduff0cu7528u4e8eu590du5236u9644u4ef6
            })
          });

          const data = await response.json();

          if (response.ok && !data.error) {
            successCount++;
            // 保存成功的分享记录（包含真实的shared_todo_id）
            let sharedTodoId = null;
            if (data.results && data.results[0] && data.results[0].shared_todo_id) {
              sharedTodoId = data.results[0].shared_todo_id;
            } else if (data.shared_todo_id) {
              sharedTodoId = data.shared_todo_id;
            }

            if (sharedTodoId) {
              successRecords.push({
                target_user_id: user.user_id,
                target_nickname: user.nickname || user.user_id,
                shared_todo_id: sharedTodoId,
                success: true,
                attachments_copied: data.results[0].attachments_copied || 0,
                attachments_failed: data.results[0].attachments_failed || 0,
                attachments_size: data.results[0].attachments_size || 0
              });
            }
          } else {
            failedCount++;
            failedList.push({
              user: user.nickname || user.user_id,
              error: data.msg || data.error || '未知错误'
            });
          }
        } catch (error) {
          failedCount++;
          failedList.push({
            user: user.nickname || user.user_id,
            error: error.message || '网络错误'
          });
        }

        // 更新进度
        progressBar.style.width = `${progress}%`;
        progressCount.textContent = `${i + 1} / ${totalCount}`;
        progressStatus.textContent = `正在分享... (${i + 1}/${totalCount})`;
      }

      // 分享完成
      progressBar.style.width = '100%';
      progressBar.classList.add('complete');
      progressStatus.classList.add('complete');
      progressStatus.textContent = `分享完成！成功 ${successCount} 个，失败 ${failedCount} 个`;

      // 保存广播分享历史
      if (successCount > 0 && typeof window.saveShareHistory === 'function' && todo && todo.id) {

        // 直接使用收集到的successRecords
        await window.saveShareHistory(todo.id, todo.title, successRecords);

      }

      // 显示详细结果
      setTimeout(() => {
        // 统计附件信息
        let totalAttachments = 0;
        let totalAttachmentsFailed = 0;
        successRecords.forEach(record => {
          totalAttachments += record.attachments_copied || 0;
          totalAttachmentsFailed += record.attachments_failed || 0;
        });

        let message = `广播分享完成！\n\n`;
        message += `✅ 成功：${successCount} 个用户\n`;

        // 添加附件信息
        if (totalAttachments > 0) {
          message += `📎 已复制：${totalAttachments} 个附件\n`;
        }
        if (totalAttachmentsFailed > 0) {
          message += `⚠️ 附件失败：${totalAttachmentsFailed} 个\n`;
        }

        if (failedCount > 0) {
          message += `\n❌ 失败：${failedCount} 个用户\n\n`;
          message += `失败详情：\n`;
          failedList.slice(0, 10).forEach(item => {
            message += `  • ${item.user}: ${item.error}\n`;
          });
          if (failedList.length > 10) {
            message += `  ... 还有 ${failedList.length - 10} 个失败\n`;
          }
        }

        alert(message);
        closeShareDialog();
      }, 1000);

    } catch (error) {
      console.error('[todo] Broadcast share failed:', error);
      progressStatus.textContent = '分享失败：' + error.message;
      progressStatus.classList.add('error');
      if (submitBtn) submitBtn.disabled = false;
      if (shareTargetInput) shareTargetInput.disabled = false;
    }
  }

  /**
   * 加载所有用户列表
   */
  async function loadAllUsers() {
    try {
      const response = await fetch(`${searchUserEndpoint}?q=`, {
        method: 'GET',
        credentials: 'same-origin',
      });

      if (response.ok) {
        const data = await response.json();
        // 过滤掉自己
        allUsersList = (data.results || []).filter(user =>
          user.user_id !== userId
        );
        return allUsersList;
      } else {
        allUsersList = [];
        return [];
      }
    } catch (error) {
      console.error('[todo] Failed to load users:', error);
      allUsersList = [];
      return [];
    }
  }

  /**
   * 渲染已选择的用户标签
   */
  function renderSelectedUsers() {
    if (!selectedUsersContainer) return;

    selectedUsersContainer.innerHTML = '';

    selectedUsers.forEach(user => {
      const tag = document.createElement('div');
      tag.className = 'selected-user-tag';
      // 只显示昵称，不显示ID
      tag.innerHTML = `
        <span class="tag-nickname">${user.nickname || user.userId}</span>
        <button type="button" class="tag-remove" data-user-id="${user.userId}" aria-label="移除">×</button>
      `;

      // 添加移除事件
      const removeBtn = tag.querySelector('.tag-remove');
      removeBtn.addEventListener('click', () => {
        removeUser(user.userId);
      });

      selectedUsersContainer.appendChild(tag);
    });
  }

  /**
   * 添加用户到已选择列表
   */
  function addUser(user) {
    // 检查是否已达到上限
    if (selectedUsers.length >= 3) {
      shareError.textContent = '最多只能选择3个用户';
      shareError.hidden = false;
      return;
    }

    // 检查是否已选择
    if (selectedUsers.some(u => u.userId === user.userId)) {
      return;
    }

    selectedUsers.push({
      userId: user.userId,
      nickname: user.nickname || ''
    });

    renderSelectedUsers();
    shareTargetUser.value = '';
    if (userDropdown) userDropdown.hidden = true;
    shareError.hidden = true;
  }

  /**
   * 从已选择列表中移除用户
   */
  function removeUser(userIdToRemove) {
    selectedUsers = selectedUsers.filter(u => u.userId !== userIdToRemove);
    renderSelectedUsers();
    shareError.hidden = true;
  }

  /**
   * 搜索用户并显示下拉列表
   */
  function searchAndShowDropdown(query) {
    if (!userDropdown) return;

    query = query.trim().toLowerCase();

    // 如果查询为空，隐藏下拉列表
    if (query === '') {
      userDropdown.hidden = true;
      return;
    }

    // 🎁 检测广播关键词，隐藏下拉列表（不提示"未找到用户"）
    const BROADCAST_KEYWORDS = [
      "@all", "@All", "@ALL",
      "@所有人", "@全部", "@所有",
      "@全部用户", "@所有用户"
    ];
    const hasBroadcast = BROADCAST_KEYWORDS.some(keyword =>
      query.includes(keyword.toLowerCase())
    );
    if (hasBroadcast) {
      userDropdown.hidden = true;
      return;
    }

    // 过滤用户列表
    const filtered = allUsersList.filter(user => {
      const nickname = (user.nickname || '').toLowerCase();
      const uid = (user.user_id || '').toLowerCase();
      return nickname.includes(query) || uid.includes(query);
    });

    // 渲染下拉列表
    renderUserDropdown(filtered);
  }

  /**
   * 渲染用户下拉列表
   */
  function renderUserDropdown(users) {
    if (!userDropdown) return;

    userDropdown.innerHTML = '';

    if (users.length === 0) {
      userDropdown.innerHTML = '<div class="user-dropdown-empty">未找到用户</div>';
      userDropdown.hidden = false;
      return;
    }

    users.forEach(user => {
      const item = document.createElement('div');
      item.className = 'user-dropdown-item';

      // 检查是否已选择（使用 user_id）
      const isSelected = selectedUsers.some(u => u.userId === user.user_id);
      if (isSelected) {
        item.classList.add('selected');
      }

      // 检查是否已达到上限
      const isDisabled = selectedUsers.length >= 3 && !isSelected;
      if (isDisabled) {
        item.classList.add('disabled');
      }

      // 只显示昵称，不显示ID
      item.innerHTML = `
        <span class="dropdown-user-nickname">${user.nickname || user.user_id}</span>
      `;

      // 添加点击事件
      if (!isDisabled) {
        item.addEventListener('click', () => {
          if (!isSelected) {
            addUser({
              userId: user.user_id,  // 使用 user_id
              nickname: user.nickname || ''
            });
          }
        });
      }

      userDropdown.appendChild(item);
    });

    userDropdown.hidden = false;
  }

  // 输入框事件监听
  if (shareTargetUser) {
    shareTargetUser.addEventListener('input', (e) => {
      searchAndShowDropdown(e.target.value);
    });

    shareTargetUser.addEventListener('focus', () => {
      searchAndShowDropdown(shareTargetUser.value);
    });

    // 点击外部关闭下拉列表
    document.addEventListener('click', (e) => {
      if (userDropdown &&
          !shareTargetUser.contains(e.target) &&
          !userDropdown.contains(e.target)) {
        userDropdown.hidden = true;
      }
    });
  }

  if (shareCancelBtn) {
    shareCancelBtn.addEventListener("click", closeShareDialog);
  }

  // 分享方式选择菜单事件
  if (shareToAppBtn) {
    shareToAppBtn.addEventListener("click", async () => {
      if (currentShareTodo) {
        const todoToShare = currentShareTodo; // 保存引用
        closeShareChoiceMenu();
        await openShareDialog(todoToShare);
      }
    });
  }

  if (shareToWechatBtn) {
    shareToWechatBtn.addEventListener("click", async () => {
      if (currentShareTodo) {
        const todoToCopy = currentShareTodo; // 保存引用
        await copyTaskToClipboard(todoToCopy);
        closeShareChoiceMenu();
      }
    });
  }

  // 协作共享按钮事件 - 跳转到协作管理页面并携带任务ID
  const collaborateShareBtn = document.querySelector("#collaborate-share-btn");
  if (collaborateShareBtn) {
    collaborateShareBtn.addEventListener("click", (e) => {
      e.preventDefault(); // 阻止默认链接跳转
      console.log('[主页] 点击协作管理按钮');
      console.log('[主页] 当前分享任务:', currentShareTodo);

      if (shareChoiceMenu) {
        shareChoiceMenu.setAttribute('hidden', '');
        shareChoiceMenu.style.display = 'none';
      }
      // 跳转到协作管理页面，携带当前任务ID
      if (currentShareTodo) {
        const targetUrl = `/todo/collaborate?task_id=${currentShareTodo.id}`;
        console.log('[主页] 跳转到:', targetUrl);
        window.location.href = targetUrl;
      } else {
        console.log('[主页] 当前无分享任务，跳转到协作管理页面');
        window.location.href = '/todo/collaborate';
      }
    });
  } else {
    console.log('[主页] 未找到协作管理按钮');
  }

  // 点击页面其他地方关闭菜单
  document.addEventListener("click", (event) => {
    if (shareChoiceMenu && !shareChoiceMenu.hidden && shareChoiceMenu.style.display !== 'none') {
      const clickedInsideMenu = shareChoiceMenu.contains(event.target);
      const clickedShareButton = event.target.closest(".share-btn");
      if (!clickedInsideMenu && !clickedShareButton) {
        closeShareChoiceMenu();
      }
    }
  });

  if (shareForm) {
    shareForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      if (!currentShareTodo) return;

      const rawInput = shareTargetUser.value.trim();

      // 🎁 彩蛋功能：优先检测广播关键词（不受3个用户限制）
      const BROADCAST_KEYWORDS = [
        "@all", "@All", "@ALL",
        "@所有人", "@全部", "@所有",
        "@全部用户", "@所有用户"
      ];

      // 检查输入框中是否包含广播关键词
      const hasBroadcastInInput = BROADCAST_KEYWORDS.some(keyword =>
        rawInput.includes(keyword)
      );

      if (hasBroadcastInInput) {
        // 显示确认提示
        const confirmed = confirm(
          "检测到广播关键词，将分享给除自己外的所有用户。\n\n" +
          "是否确认分享给所有人？"
        );

        if (!confirmed) {
          return;
        }

        // 先获取所有用户列表
        await handleBroadcastShare(currentShareTodo);
        return; // 广播完成，直接返回
      }

      // 非广播模式：正常的多用户分享逻辑
      let targetIdentifiers = [];

      if (selectedUsers.length > 0) {
        // 使用已选择的用户
        targetIdentifiers = selectedUsers.map(u => u.userId);
      } else if (rawInput) {
        // 手动输入（支持多用户逗号分隔）
        targetIdentifiers = rawInput
          .split(/[\s,，;；、]+/)
          .map(id => id.trim())
          .filter(id => id.length > 0);
      } else {
        shareError.textContent = "请选择或输入目标用户";
        shareError.hidden = false;
        return;
      }

      if (targetIdentifiers.length === 0) {
        shareError.textContent = "请选择或输入目标用户";
        shareError.hidden = false;
        return;
      }

      // 检查是否包含自己
      const selfIdentifiers = targetIdentifiers.filter(identifier =>
        identifier.toLowerCase() === userId.toLowerCase() ||
        (userNickname && identifier.toLowerCase() === userNickname.toLowerCase())
      );

      if (selfIdentifiers.length > 0) {
        shareError.textContent = "不能分享给自己";
        shareError.hidden = false;
        return;
      }

      // 发送分享请求到后端
      try {
		// 获取署名选项
		const signatureRadio = document.querySelector('input[name="share-signature"]:checked');
		const isSigned = signatureRadio ? signatureRadio.value === 'signed' : true; // 默认署名

		// 显示进度条（复用广播分享的进度条）
		const progressContainer = document.getElementById('share-progress-container');
		const progressBar = document.getElementById('share-progress-bar');
		const progressCount = document.getElementById('share-progress-count');
		const progressStatus = document.getElementById('share-progress-status');
		const submitBtn = document.getElementById('share-submit-btn');

		if (progressContainer && progressBar && progressStatus) {
		  // 禁用提交按钮
		  if (submitBtn) submitBtn.disabled = true;
		  shareTargetUser.disabled = true;

		  // 显示进度条
		  progressContainer.hidden = false;
		  progressBar.style.width = '50%';
		  progressBar.classList.remove('complete');
		  progressStatus.classList.remove('complete', 'error');
		  progressStatus.textContent = '正在分享...';
		  progressCount.textContent = `${targetIdentifiers.length} 个用户`;
		}

		const response = await fetch(`${apiEndpoint}/share`, {
		  method: "POST",
		  headers: { "Content-Type": "application/json" },
		  body: JSON.stringify({
			target_users: targetIdentifiers,
			todo: currentShareTodo,
			signed: isSigned,  // ← 新增：署名标识
			from_nickname: isSigned ? userNickname : null,  // ← 只在署名时发送昵称
			source_user_id: userId  // u2190 u65b0u589euff1au5206u4eabu8005u7684user_iduff0cu7528u4e8eu590du5236u9644u4ef6
		  })
		});

		// 更新进度：处理响应中
		if (progressBar && progressStatus) {
		  progressBar.style.width = '80%';
		  progressStatus.textContent = '处理中...';
		}

		// ✅ 防御性解析：即使返回不是JSON，也不会报错
		let data;
		try {
		  const text = await response.text();
		  data = text ? JSON.parse(text) : {};
		} catch (e) {
		  console.warn("[todo] 非JSON响应:", e);
		  data = {};
		}

		// ✅ 稳健判断逻辑
		if (!response.ok || data.error || data.status === "error") {
		  // 显示错误状态
		  if (progressBar && progressStatus) {
		    progressBar.style.width = '100%';
		    progressStatus.classList.add('error');
		    progressStatus.textContent = '分享失败';
		  }
		  throw new Error(data.error || data.msg || "分享失败，请稍后重试。");
		}

		// 更新进度：完成
		if (progressBar && progressStatus) {
		  progressBar.style.width = '100%';
		  progressBar.classList.add('complete');
		  progressStatus.classList.add('complete');
		}

		// 显示分享结果
		if (data.results && Array.isArray(data.results)) {
		  const successCount = data.results.filter(r => r.success).length;
		  const failedCount = data.results.filter(r => !r.success).length;

		  // 统计附件信息
		  let totalAttachments = 0;
		  let totalAttachmentsFailed = 0;
		  data.results.filter(r => r.success).forEach(r => {
		    totalAttachments += r.attachments_copied || 0;
		    totalAttachmentsFailed += r.attachments_failed || 0;
		  });

		  // 更新进度状态显示附件信息
		  if (progressStatus) {
		    if (totalAttachments > 0) {
		      progressStatus.textContent = `完成！已复制 ${totalAttachments} 个附件`;
		    } else {
		      progressStatus.textContent = `分享完成！`;
		    }
		  }

		  let message = `成功分享给 ${successCount} 个用户`;

		  // 添加附件信息
		  if (totalAttachments > 0) {
		    message += `\n📎 已复制 ${totalAttachments} 个附件`;
		  }
		  if (totalAttachmentsFailed > 0) {
		    message += `\n⚠️ ${totalAttachmentsFailed} 个附件复制失败`;
		  }

		  if (failedCount > 0) {
		    message += `\n\n失败 ${failedCount} 个：\n`;
		    data.results.filter(r => !r.success).forEach(r => {
		      message += `  - ${r.identifier}: ${r.error}\n`;
		    });
		  }
		  alert(message);
		} else {
		  // 兼容旧版单用户响应
		  const displayName = data.target_nickname || data.target_user || targetIdentifiers[0];
		  alert(data.msg || `任务已成功分享给「${displayName}」`);
		}

		// 保存分享历史（处理多用户和单用户格式）
		if (typeof window.saveShareHistory === 'function' && currentShareTodo && currentShareTodo.id) {
		  if (data.results && Array.isArray(data.results)) {
		    // 多用户格式
		    window.saveShareHistory(currentShareTodo.id, currentShareTodo.title, data.results);
		  } else if (data.shared_todo_id) {
		    // 单用户格式 - 构造结果数组
		    const singleResult = [{
		      target_user_id: data.target_user || targetIdentifiers[0],
		      target_nickname: data.target_nickname || '',
		      shared_todo_id: data.shared_todo_id,
		      success: true
		    }];
		    window.saveShareHistory(currentShareTodo.id, currentShareTodo.title, singleResult);
		  }
		}
		closeShareDialog();

      } catch (error) {
        console.error("[todo] Share failed:", error);
        shareError.textContent = error.message || "分享失败，请稍后重试";
        shareError.hidden = false;

        // 恢复按钮状态
        const submitBtn = document.getElementById('share-submit-btn');
        if (submitBtn) submitBtn.disabled = false;
        shareTargetUser.disabled = false;
      }
    });
  }

  /**
   * 显示删除确认对话框
   * @param {Object} todo - 要删除的任务对象
   * @returns {Promise<{confirmed: boolean, deleteFiles: boolean}>}
   */
  async function showDeleteConfirmDialog(todo) {
    const overlay = document.getElementById('delete-confirm-overlay');
    const messageEl = document.getElementById('delete-confirm-message');
    const attachmentInfoEl = document.getElementById('delete-attachment-info');
    const attachmentCountEl = document.getElementById('delete-attachment-count');
    const deleteFilesCheckbox = document.getElementById('delete-files-checkbox');
    const confirmBtn = document.getElementById('delete-confirm-btn');
    const cancelBtn = document.getElementById('delete-cancel-btn');

    if (!overlay) {
      // 回退到简单确认
      const name = todo?.title?.trim() ? `「${todo.title.trim()}」` : "该任务";
      return {
        confirmed: window.confirm(`确认删除${name}？此操作无法恢复。`),
        deleteFiles: false
      };
    }

    // 设置任务名称
    const name = todo?.title?.trim() ? `「${todo.title.trim()}」` : "该任务";
    messageEl.textContent = `确定要删除${name}吗？`;

    // 获取附件数量
    let attachmentCount = 0;
    try {
      const response = await fetch(`/todo/api/todos/${todo.id}/attachments?user_id=${userId}`);
      if (response.ok) {
        const data = await response.json();
        attachmentCount = data.data?.total_count || 0;
      }
    } catch (error) {
      console.warn('[todo] Failed to get attachment count:', error);
    }

    // 显示/隐藏附件信息
    if (attachmentCount > 0) {
      attachmentCountEl.textContent = attachmentCount;
      attachmentInfoEl.hidden = false;
      deleteFilesCheckbox.checked = false; // 默认不删除物理文件
    } else {
      attachmentInfoEl.hidden = true;
    }

    // 显示对话框
    overlay.hidden = false;

    return new Promise((resolve) => {
      const cleanup = () => {
        overlay.hidden = true;
        confirmBtn.removeEventListener('click', handleConfirm);
        cancelBtn.removeEventListener('click', handleCancel);
        overlay.removeEventListener('click', handleOverlayClick);
      };

      const handleConfirm = () => {
        cleanup();
        resolve({
          confirmed: true,
          deleteFiles: deleteFilesCheckbox.checked
        });
      };

      const handleCancel = () => {
        cleanup();
        resolve({ confirmed: false, deleteFiles: false });
      };

      const handleOverlayClick = (e) => {
        if (e.target === overlay) {
          handleCancel();
        }
      };

      confirmBtn.addEventListener('click', handleConfirm);
      cancelBtn.addEventListener('click', handleCancel);
      overlay.addEventListener('click', handleOverlayClick);
    });
  }

  function startEdit(listItem) {
    if (listItem.classList.contains("editing")) return;
    const id = listItem.dataset.id;
    const todo = todos.find((item) => item.id === id);
    if (!todo) return;

    listItem.classList.add("editing");
    const details = listItem.querySelector(".todo-details");
    if (!details) return;

    const titleField = document.createElement("input");
    titleField.type = "text";
    titleField.value = todo.title;
    titleField.className = "todo-edit-input todo-edit-title";
    titleField.setAttribute("aria-label", "编辑任务标题");
    titleField.placeholder = "任务标题";

    const startTimestamp =
      normalizeTimestamp(todo.startAt) ??
      normalizeTimestamp(todo.createdAt) ??
      Date.now();

    const startGroup = document.createElement("div");
    startGroup.className = "start-group";

    const startDateLabel = document.createElement("label");
    startDateLabel.className = "start-field";
    startDateLabel.htmlFor = `todo-edit-start-date-${id}`;
    const startDateLabelText = document.createElement("span");
    startDateLabelText.textContent = "开始日期";
    const startDateField = document.createElement("input");
    startDateField.type = "date";
    startDateField.id = `todo-edit-start-date-${id}`;
    startDateField.setAttribute("aria-label", "编辑开始日期");

    const startTimeLabel = document.createElement("label");
    startTimeLabel.className = "start-field";
    startTimeLabel.htmlFor = `todo-edit-start-time-${id}`;
    const startTimeLabelText = document.createElement("span");
    startTimeLabelText.textContent = "开始时间";
    const startTimeField = document.createElement("input");
    startTimeField.type = "time";
    startTimeField.step = "60";
    startTimeField.id = `todo-edit-start-time-${id}`;
    startTimeField.setAttribute("aria-label", "编辑开始时间");

    startDateLabel.append(startDateLabelText, startDateField);
    startTimeLabel.append(startTimeLabelText, startTimeField);
    startGroup.append(startDateLabel, startTimeLabel);
    fillDateTimeInputs(startDateField, startTimeField, startTimestamp);

    // 重复选项组
    const repeatContainer = document.createElement("div");
    repeatContainer.className = "repeat-options";

    const repeatConfig = todo.repeatConfig || { mode: todo.repeatDaily ? "daily" : "none", hours: 1 };
    const currentMode = repeatConfig.mode || "none";
    const currentHours = repeatConfig.hours || 1;

    // 创建三个单选按钮
    const repeatModes = [
      { value: "none", label: "不重复" },
      { value: "daily", label: "日重复" },
      { value: "custom", label: "自定义" }
    ];

    const repeatRadios = {};
    repeatModes.forEach(mode => {
      const label = document.createElement("label");
      label.className = "repeat-option";

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = `repeat-mode-${id}`;
      radio.value = mode.value;
      radio.id = `repeat-mode-${mode.value}-${id}`;
      radio.checked = currentMode === mode.value;
      radio.setAttribute("aria-label", mode.label);

      const span = document.createElement("span");
      span.textContent = mode.label;

      label.htmlFor = `repeat-mode-${mode.value}-${id}`;

      // 阻止label点击时触发blur导致的编辑提交
      label.addEventListener("mousedown", (e) => {
        e.preventDefault(); // 阻止默认行为，避免触发blur
        radio.click(); // 手动触发radio点击
      });

      label.append(radio, span);
      repeatContainer.append(label);
      repeatRadios[mode.value] = radio;
    });

    // 自定义重复小时数输入
    const customRepeatDiv = document.createElement("div");
    customRepeatDiv.className = "custom-repeat-panel";
    customRepeatDiv.hidden = currentMode !== "custom";

    // 创建内部行容器
    const customRepeatRow = document.createElement("div");
    customRepeatRow.className = "custom-repeat-row";

    // 下拉菜单选择器
    const presetLabel = document.createElement("label");
    presetLabel.className = "custom-repeat-field";
    const presetLabelText = document.createElement("span");
    presetLabelText.textContent = "间隔类型";
    const presetSelect = document.createElement("select");
    presetSelect.className = "todo-edit-preset-select";
    presetSelect.setAttribute("aria-label", "间隔类型");
    presetSelect.disabled = currentMode !== "custom"; // 初始根据模式设置禁用状态

    // 判断当前小时数对应哪个预设值
    let initialPreset = "custom";
    if (currentHours === 168) {
      initialPreset = "168";
    } else if (currentHours === 720) {
      initialPreset = "720";
    }

    const presetOptions = [
      { value: "168", label: "每周重复 (168小时)" },
      { value: "720", label: "每月重复 (720小时)" },
      { value: "custom", label: "自定义间隔" }
    ];

    presetOptions.forEach(opt => {
      const option = document.createElement("option");
      option.value = opt.value;
      option.textContent = opt.label;
      option.selected = opt.value === initialPreset;
      presetSelect.appendChild(option);
    });

    presetLabel.append(presetLabelText, presetSelect);

    // 自定义小时数输入框
    const hoursLabel = document.createElement("label");
    hoursLabel.className = "custom-repeat-field";
    hoursLabel.hidden = initialPreset !== "custom";
    const hoursLabelText = document.createElement("span");
    hoursLabelText.textContent = "自定义小时数";
    const hoursInput = document.createElement("input");
    hoursInput.type = "number";
    hoursInput.min = "1";
    hoursInput.max = "8760";
    hoursInput.value = currentHours.toString();
    hoursInput.className = "todo-edit-hours-input";
    hoursInput.setAttribute("aria-label", "重复间隔小时数");
    hoursInput.disabled = currentMode !== "custom"; // 初始根据模式设置禁用状态
    hoursLabel.append(hoursLabelText, hoursInput);

    // 提示信息
    const hintsDiv = document.createElement("div");
    hintsDiv.className = "repeat-hints";
    const updateEditHints = () => {
      let hours = 1;
      const presetValue = presetSelect.value;

      if (presetValue === 'custom') {
        hours = parseInt(hoursInput.value) || 1;
      } else {
        hours = parseInt(presetValue) || 1;
      }

      const weeklyCount = Math.floor(168 / hours);
      const monthlyCount = Math.floor(720 / hours);
      hintsDiv.innerHTML = `<span class="hint-label">提示：</span><span class="hint-value">每周 ${weeklyCount} 次</span><span class="hint-separator">|</span><span class="hint-value">每月 ${monthlyCount} 次</span>`;
    };
    updateEditHints();

    // 下拉菜单变化时的处理
    presetSelect.addEventListener("change", () => {
      hoursLabel.hidden = presetSelect.value !== "custom";
      updateEditHints();
    });

    hoursInput.addEventListener("input", updateEditHints);

    customRepeatRow.append(presetLabel, hoursLabel, hintsDiv);
    customRepeatDiv.append(customRepeatRow);

    // 监听模式切换
    Object.values(repeatRadios).forEach(radio => {
      radio.addEventListener("change", () => {
        const isCustomMode = radio.value === "custom";
        customRepeatDiv.hidden = !isCustomMode;
        // 启用或禁用间隔类型和小时数输入框
        presetSelect.disabled = !isCustomMode;
        hoursInput.disabled = !isCustomMode;
      });
    });

    const contentField = document.createElement("textarea");
    contentField.value = todo.content || "";
    contentField.className = "todo-edit-input todo-edit-content";
    contentField.setAttribute("aria-label", "编辑任务内容");
    contentField.placeholder = "任务内容（可选）";

    // 添加确认和取消按钮
    const formActions = document.createElement("div");
    formActions.className = "form-actions";

    const buttonContainer = document.createElement("div");
    buttonContainer.className = "form-buttons";

    const confirmButton = document.createElement("button");
    confirmButton.type = "button";
    confirmButton.className = "form-confirm";
    confirmButton.textContent = "确认";
    confirmButton.setAttribute("aria-label", "确认编辑");

    // 防止按钮点击触发blur
    confirmButton.addEventListener("mousedown", (e) => {
      e.preventDefault();
    });

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "form-cancel";
    cancelButton.textContent = "取消";
    cancelButton.setAttribute("aria-label", "取消编辑");

    // 防止按钮点击触发blur
    cancelButton.addEventListener("mousedown", (e) => {
      e.preventDefault();
    });

    buttonContainer.append(confirmButton, cancelButton);
    formActions.append(buttonContainer);

    details.replaceChildren(titleField, contentField, startGroup, repeatContainer, customRepeatDiv, formActions);

    let cancelled = false;
    let finished = false;

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        cancelled = true;
        finished = true;
        listItem.classList.remove("editing");
        render();
        return;
      }
      if (event.key === "Enter") {
        const isTitleSubmit =
          event.target === titleField &&
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey;
        const isContentSubmit =
          event.target === contentField && (event.ctrlKey || event.metaKey);
        const isStartSubmit =
          (event.target === startDateField || event.target === startTimeField) &&
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey;
        if (isTitleSubmit || isContentSubmit || isStartSubmit) {
          event.preventDefault();
          commitEdit();
        }
      }
    };

    titleField.addEventListener("keydown", handleKeyDown);
    contentField.addEventListener("keydown", handleKeyDown);
    startDateField.addEventListener("keydown", handleKeyDown);
    startTimeField.addEventListener("keydown", handleKeyDown);
    hoursInput.addEventListener("keydown", handleKeyDown);

    // ========== 原blur自动提交逻辑已禁用 (2025-11-25) ==========
    // 原因：移动端容易误触背景导致意外退出编辑
    // 现在只能通过以下方式提交编辑：
    //   1. 点击"确认"按钮
    //   2. 点击"取消"按钮
    //   3. 按Enter键（标题/日期/时间字段）或Ctrl+Enter（内容字段）
    //   4. 按ESC键取消
    // =========================================================
    
    // const handleBlur = (event) => {
    //   if (finished || cancelled) return;
    //   setTimeout(() => {
    //     if (finished || cancelled) return;
    //     const activeEl = document.activeElement;
    //     const clickedElement = event.relatedTarget;
    //     if (!listItem.contains(activeEl) && !listItem.contains(clickedElement)) {
    //       commitEdit();
    //     }
    //   }, 150);
    // };

    // titleField.addEventListener("blur", handleBlur);
    // contentField.addEventListener("blur", handleBlur);
    // startDateField.addEventListener("blur", handleBlur);
    // startTimeField.addEventListener("blur", handleBlur);
    // hoursInput.addEventListener("blur", handleBlur);

    contentField.focus();
    contentField.setSelectionRange(contentField.value.length, contentField.value.length);

    // 确认按钮点击事件
    confirmButton.addEventListener("click", () => {
      commitEdit();
    });

    // 取消按钮点击事件
    cancelButton.addEventListener("click", () => {
      cancelled = true;
      finished = true;
      listItem.classList.remove("editing");
      render();
    });

    function commitEdit() {
      if (finished) return;
      finished = true;
      listItem.classList.remove("editing");
      const nextTitle = titleField.value.trim();
      const nextContent = contentField.value.trim();
      if (!nextTitle) {
        // 标题为空时，显示删除确认对话框
        showDeleteConfirmDialog(todo).then(result => {
          if (result.confirmed) {
            deleteTodo(id, result.deleteFiles).catch((error) => console.warn("Delete failed", error));
          } else {
            render();
          }
        });
        return;
      }
      todo.title = nextTitle;
      todo.content = nextContent;
      todo.startAt = combineDateAndTime(
        startDateField.value,
        startTimeField.value,
        todo.startAt ?? todo.createdAt ?? Date.now()
      );
      // 保存重复配置
      const selectedMode = Object.keys(repeatRadios).find(key => repeatRadios[key].checked) || "none";
      let hours = 0;

      if (selectedMode === "custom") {
        // 从下拉菜单获取小时数
        const presetValue = presetSelect.value;
        if (presetValue === 'custom') {
          hours = parseInt(hoursInput.value) || 1;
        } else {
          hours = parseInt(presetValue) || 1;
        }
      } else if (selectedMode === "daily") {
        hours = 24;
      }

      todo.repeatDaily = selectedMode === "daily";
      todo.repeatConfig = {
        mode: selectedMode,
        hours: hours
      };
      touch(todo);
      saveAndRender().catch((error) => console.warn("Save failed", error));
    }
  }

  function render() {
    todoList.innerHTML = "";

    let items = applyFilter(todos, activeFilter);
    if (activeFilter === "all" && !showCompleted) {
      items = items.filter((todo) => !todo.completed);
    }
    items = filterBySearchTerms(items, searchTerms);

    if (items.length === 0) {
      const placeholder = document.createElement("li");
      placeholder.className = "todo-empty";
      if (searchTerms.length) {
        placeholder.textContent = "未找到匹配任务，试试调整关键词。";
      } else {
        placeholder.textContent = "暂无任务，立即添加一条吧。";
      }
      todoList.appendChild(placeholder);
    } else {
      for (const todo of items) {
        const node = template.content.firstElementChild.cloneNode(true);
        node.dataset.id = todo.id;
        // 设置附件按钮的data-todo-id属性
        const attachmentBtn = node.querySelector('.attachment-btn');
        if (attachmentBtn) {
          attachmentBtn.setAttribute('data-todo-id', todo.id);
        }
        const titleEl = node.querySelector(".todo-title");
        const contentEl = node.querySelector(".todo-content");
        const dateEl = node.querySelector(".todo-date");
        const repeatBadge = node.querySelector(".todo-repeat-badge");
        const startTs =
          normalizeTimestamp(todo.startAt) ??
          normalizeTimestamp(todo.createdAt);
        const hasStart = startTs != null;
        const isFuture =
          hasStart && startTs >= Date.now();
        node.classList.toggle("future", hasStart && isFuture);
        node.classList.toggle("past", hasStart && !isFuture);
        node.classList.toggle("pinned", !!todo.pinned);  // ← 添加这一行
        if (titleEl) {
          titleEl.textContent = todo.title;
          // 先移除旧的协作徽章（如果存在）
          const oldBadge = titleEl.parentNode.querySelector('.collaborate-badge');
          if (oldBadge) oldBadge.remove();
          // 协作任务显示标识
          if (todo.isCollaborative) {
            node.classList.add('collaborative');
            const badge = document.createElement('span');
            badge.className = 'collaborate-badge';
            badge.innerHTML = '<span class="collaborate-badge-icon">👥</span><span>' + (todo.collaborators ? todo.collaborators.length : '') + '</span>';
            badge.title = '协作任务 - 点击管理协作者';
            badge.dataset.todoId = todo.id;
            badge.addEventListener('click', (e) => {
              e.stopPropagation();
              // 跳转到协作管理页面，携带任务ID
              window.location.href = `/todo/collaborate?task_id=${todo.id}`;
            });
            titleEl.parentNode.insertBefore(badge, titleEl.nextSibling);
          } else {
            node.classList.remove('collaborative');
          }
        }
        if (contentEl) {
          if (todo.content) {
            // 保存原始Markdown内容（未渲染的）
            contentEl.setAttribute('data-original-markdown', todo.content);

            // 应用用户保存的行排序偏好
            const lineOrderPrefs = JSON.parse(localStorage.getItem('lineOrderPrefs') || '{}');
            const savedOrder = lineOrderPrefs[todo.id];

            // 如果用户之前设置过倒序，应用倒序
            if (savedOrder === 'reverse') {
              const lines = todo.content.split('\n');
              const reversedLines = [...lines].reverse();
              const reorderedMarkdown = reversedLines.join('\n');
              contentEl.innerHTML = renderMarkdown(reorderedMarkdown);

              // 设置对应按钮为active
              setTimeout(() => {
                const orderBtns = node.querySelectorAll('.line-order-btn');
                orderBtns.forEach(btn => {
                  if (btn.dataset.order === 'reverse') {
                    btn.classList.add('active');
                  } else {
                    btn.classList.remove('active');
                  }
                });
              }, 0);
            } else {
              // 正常顺序，直接渲染
              contentEl.innerHTML = renderMarkdown(todo.content);
            }
          } else {
            contentEl.textContent = "";
          }
        }
        if (dateEl) {
          if (startTs != null) {
            dateEl.textContent = formatDateCompact(startTs);
            dateEl.dateTime = new Date(startTs).toISOString();
            dateEl.title = new Date(startTs).toLocaleString();
          } else {
            dateEl.textContent = "";
            dateEl.removeAttribute("datetime");
            dateEl.removeAttribute("title");
          }
        }
        if (repeatBadge) {
          const config = todo.repeatConfig || { mode: "none", hours: 0 };
          const hasRepeat = config.mode !== "none";

          repeatBadge.hidden = !hasRepeat;
          if (!repeatBadge.hidden) {
            if (config.mode === "daily") {
              repeatBadge.textContent = "每日";
              repeatBadge.title = "每日重复任务";
            } else if (config.mode === "custom") {
              const hours = config.hours || 24;
              if (hours < 24) {
                repeatBadge.textContent = `${hours}h`;
                repeatBadge.title = `每${hours}小时重复`;
              } else if (hours === 24) {
                repeatBadge.textContent = "每日";
                repeatBadge.title = "每24小时重复";
              } else {
                const days = Math.floor(hours / 24);
                repeatBadge.textContent = `${days}天`;
                repeatBadge.title = `每${hours}小时重复（约${days}天）`;
              }
            }
          } else {
            repeatBadge.removeAttribute("title");
          }
        }
        const toggle = node.querySelector(".todo-toggle");
        toggle.checked = todo.completed;
        const pinToggle = node.querySelector(".todo-pin");
        if (pinToggle) pinToggle.checked = !!todo.pinned;
        if (todo.completed) node.classList.add("completed");

        todoList.appendChild(node);
      }
    }

    // 手机端：将所有复选框移动到 item-actions 底部
    setupMobileCheckboxes();

    updateFilterButtons();
    updateSecondaryActionButton();
    updateCount();
    updateAddButtonState();
  }

  function updateAddButtonState() {
    if (!addButton) return;
    addButton.disabled = titleInput.value.trim().length === 0;
  }

  function setupMobileCheckboxes() {
    const isMobile = window.innerWidth <= 720;
    const todoItems = todoList.querySelectorAll('.todo-item');

    todoItems.forEach(item => {
      const checkbox = item.querySelector('.checkbox');
      const todoHeader = item.querySelector('.todo-header');

      if (!checkbox || !todoHeader) return;

      if (isMobile) {
        // 手机端：将复选框移动到标题行的最前面
        if (checkbox.parentElement !== todoHeader) {
          todoHeader.insertBefore(checkbox, todoHeader.firstChild);
        }
      } else {
        // PC端：确保复选框在 todo-item 的第一个位置
        if (checkbox.parentElement !== item) {
          item.insertBefore(checkbox, item.firstChild);
        }
      }
    });
  }

  function updateSecondaryActionButton() {
    if (!secondaryActionBtn) return;
    if (activeFilter === "all") {
      secondaryActionBtn.hidden = false;
      secondaryActionBtn.textContent = showCompleted ? "隐藏已完成" : "显示已完成";
    } else if (activeFilter === "completed") {
      secondaryActionBtn.hidden = false;
      secondaryActionBtn.textContent = "清除已完成";
    } else {
      secondaryActionBtn.hidden = true;
    }
  }

  function updateFilterButtons() {
    const buttons = filters.querySelectorAll("button[data-filter]");
    for (const button of buttons) {
      button.classList.toggle("active", button.dataset.filter === activeFilter);
    }
  }

  function updateCount() {
    const remaining = todos.filter((todo) => !todo.completed).length;
    const completed = todos.filter((todo) => todo.completed).length;
    const total = todos.length;

    if (activeFilter === "all") {
      countLabel.textContent = `共有${total}个任务`;
    } else if (activeFilter === "active") {
      countLabel.textContent = `${remaining}个任务待完成`;
    } else if (activeFilter === "completed") {
      countLabel.textContent = `已完成${completed}个任务`;
    }
  }

  function getFormStartTimestamp() {
    const fallback = Date.now();
    if (!startDateInput && !startTimeInput) {
      return fallback;
    }
    return combineDateAndTime(
      startDateInput ? startDateInput.value : "",
      startTimeInput ? startTimeInput.value : "",
      fallback
    );
  }

  function resetStartInputs(timestamp = Date.now()) {
    if (startDateInput && startTimeInput) {
      fillDateTimeInputs(startDateInput, startTimeInput, timestamp);
    }
    if (repeatNoneInput) {
      repeatNoneInput.checked = true;
    }
    if (customRepeatPanel) {
      customRepeatPanel.hidden = true;
    }
    if (repeatHoursInput) {
      repeatHoursInput.value = "1";
      updateRepeatHints();
    }
  }

  function setFormVisibility(expanded) {
    const nextState = !!expanded;
    if (formToggle) {
      formToggle.setAttribute("aria-expanded", String(nextState));
      formToggle.textContent = nextState ? "折叠任务" : "添加任务";
    }
    if (form) {
      form.hidden = !nextState;
    }
    if (nextState) {
      resetStartInputs();
      window.requestAnimationFrame(() => titleInput.focus());
    } else if (formToggle) {
      window.requestAnimationFrame(() => formToggle.focus());
    }
  }

  function fillDateTimeInputs(dateElement, timeElement, timestamp) {
    if (!dateElement || !timeElement) return;
    const { dateValue, timeValue } = toDateTimeInputs(timestamp);
    dateElement.value = dateValue;
    timeElement.value = timeValue;
  }

  function refreshRepeatingTodos(reference = Date.now()) {
    const todayStart = startOfDay(reference);
    let updated = false;

    for (const todo of todos) {
      // 检查重复配置
      const config = todo.repeatConfig || { mode: todo.repeatDaily ? "daily" : "none", hours: 0 };
      const hasRepeat = config.mode !== "none";

      if (!hasRepeat) continue;

      const startTs =
        normalizeTimestamp(todo.startAt) ??
        normalizeTimestamp(todo.createdAt) ??
        reference;

      let nextStart;
      let shouldUpdate = false;

      if (config.mode === "daily") {
        // 每日重复：对齐到今天的同一时间
        if (startTs >= todayStart) continue;
        nextStart = alignTimestampToDay(startTs, todayStart);
        if (nextStart !== startTs) {
          shouldUpdate = true;
        }
      } else if (config.mode === "custom") {
        // 自定义重复：基于间隔小时数
        const intervalMs = (config.hours || 24) * 60 * 60 * 1000;

        // 如果任务还未开始，跳过
        if (startTs > reference) continue;

        // 计算从开始到现在经过的时间
        const elapsed = reference - startTs;

        // 计算已经过了多少个完整周期
        const cyclesPassed = Math.floor(elapsed / intervalMs);

        // 计算当前周期的开始时间
        const currentCycleStart = startTs + cyclesPassed * intervalMs;

        // 如果任务已完成，检查是否需要进入下一个周期
        if (todo.completed) {
          // 如果还在当前周期内，不更新
          if (reference < currentCycleStart + intervalMs) {
            continue;
          }
          // 已进入下一周期，需要重置任务
          nextStart = currentCycleStart + intervalMs;
          shouldUpdate = true;
        } else {
          // 任务未完成，只更新 startAt 到当前周期（保持任务可见）
          if (todo.startAt !== currentCycleStart) {
            todo.startAt = currentCycleStart;
            touch(todo);
            updated = true;
          }
          continue;
        }
      } else {
        continue;
      }

      if (!shouldUpdate) continue;

      todo.startAt = nextStart;
      if (todo.completed) {
        todo.completed = false;
      }
      touch(todo);
      updated = true;
    }

    return updated;
  }

  function applyFilter(items, filter) {
    if (filter === "active") return items.filter((item) => !item.completed);
    if (filter === "completed") return items.filter((item) => item.completed);
    return items;
  }

  function normalizeSearchTerms(value) {
    if (!value || typeof value !== "string") return [];
    return value
      .trim()
      .split(/\s+/)
      .map((term) => term.toLowerCase())
      .filter(Boolean);
  }

  function filterBySearchTerms(items, terms) {
    if (!terms || !terms.length) return items;
    return items.filter((todo) => {
      const source = `${todo.title || ""} ${todo.content || ""}`.toLowerCase();
      return terms.every((term) => source.includes(term));
    });
  }

  async function fetchServerPayload() {
    if (!isValidUserId(userId)) {
      return null;
    }
    try {
      const response = await fetch(buildApiUrl(), {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) {
        return null;
      }
      const data = await response.json();
      if (!data || typeof data !== "object") {
        return null;
      }
      const itemsRaw = Array.isArray(data.items) ? data.items : [];
      const items = normalizeTodoCollection(itemsRaw);
      const prefsRaw = data.preferences;
      const prefs =
        prefsRaw && typeof prefsRaw === "object"
          ? { ...defaultPreferences, ...prefsRaw }
          : { ...defaultPreferences };
      return { items, preferences: prefs };
    } catch (error) {
      console.debug("[todo] Fetch server payload failed", error);
      return null;
    }
  }

  async function loadTodosFromCaches() {
    const fallback = () => loadFromLocalStorage();
    try {
      const db = await dbPromise;
      if (db) {
        const fromDb = await readAllFromIndexedDB(db);
        if (fromDb.length) {
          saveToLocalStoragePayload(serializeTodos(fromDb));
          return sortTodos(fromDb);
        }
      }
    } catch (error) {
      console.debug("[todo] IndexedDB load failed, fallback to localStorage", error);
    }
    const local = fallback();
    const db = await dbPromise;
    if (local.length && db) {
      await writeAllToIndexedDB(db, serializeTodos(local));
    }
    return sortTodos(local);
  }

  async function saveAndRender() {
    const refreshed = refreshRepeatingTodos();
    todos = sortTodos(todos);
    await saveTodos();
    render();
    return refreshed;
  }

  async function saveTodos() {
    const payload = serializeTodos(todos);
    saveToLocalStoragePayload(payload);
    try {
      const db = await dbPromise;
      if (db) {
        await writeAllToIndexedDB(db, payload);
      }
    } catch (error) {
      console.debug("[todo] IndexedDB write failed", error);
    }
    scheduleServerSync();
  }

  function buildApiUrl() {
    if (!isValidUserId(userId)) {
      return apiEndpoint;
    }
    const params = new URLSearchParams({ user_id: userId });
    return `${apiEndpoint}?${params.toString()}`;
  }

  function loadFromLocalStorage() {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return normalizeTodoCollection(parsed);
    } catch (error) {
      console.warn("Failed to load todos from localStorage:", error);
      return [];
    }
  }

  function saveToLocalStoragePayload(payload) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(payload));
    } catch (error) {
      console.warn("Failed to save todos to localStorage:", error);
    }
  }

  function scheduleServerSync() {
    if (!isValidUserId(userId)) {
      if (syncTimer) {
        clearTimeout(syncTimer);
        syncTimer = null;
      }
      return;
    }
    if (syncDelay <= 0) {
      syncToServer();
      return;
    }
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      syncToServer();
    }, syncDelay);
  }

  async function syncToServer() {
    if (!isValidUserId(userId)) {
      return;
    }
    try {
      const response = await fetch(buildApiUrl(), {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify({
          items: serializeTodos(todos),
          preferences,
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      console.debug("[todo] Sync to server failed", error);
    }
  }

  function loadPreferences() {
    try {
      const raw = localStorage.getItem(preferenceKey);
      if (!raw) return { ...defaultPreferences };
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return { ...defaultPreferences, ...parsed };
      }
      return { ...defaultPreferences };
    } catch (error) {
      console.debug("[todo] Failed to load preferences", error);
      return { ...defaultPreferences };
    }
  }

  function persistPreferencesLocal(nextPreferences = preferences) {
    try {
      localStorage.setItem(preferenceKey, JSON.stringify(nextPreferences));
    } catch (error) {
      console.debug("[todo] Failed to save preferences", error);
    }
  }

  function savePreferences({ sync = true } = {}) {
    persistPreferencesLocal();
    if (sync) scheduleServerSync();
  }

  function serializeTodos(items) {
    return items.map((todo) => ({
      id: todo.id,
      title: todo.title,
      text: todo.title, // 兼容旧版本字段
      content: todo.content || "",
      completed: !!todo.completed,
      pinned: !!todo.pinned,

      startAt: todo.startAt ?? todo.createdAt,
      repeatDaily: !!todo.repeatDaily,
      repeatConfig: todo.repeatConfig || { mode: todo.repeatDaily ? "daily" : "none", hours: todo.repeatDaily ? 24 : 0 },
      createdAt: todo.createdAt,
      updatedAt: todo.updatedAt || todo.createdAt,
      // 协作任务相关字段
      isCollaborative: !!todo.isCollaborative,
      collaborators: todo.collaborators || [],
    }));
  }

  function normalizeTodoCollection(records) {
    const normalized = records
      .map((record) => normalizeTodoRecord(record))
      .filter(Boolean);
    return sortTodos(normalized);
  }

  function normalizeTodoRecord(record) {
    if (!record || typeof record.id !== "string") return null;
    const title =
      typeof record.title === "string"
        ? record.title
        : typeof record.text === "string"
        ? record.text
        : "";
    if (!title.trim()) return null;
    const content = typeof record.content === "string" ? record.content : "";
    const createdAt = normalizeTimestamp(record.createdAt) ?? Date.now();
    const startAt = normalizeTimestamp(record.startAt) ?? createdAt;
    const updatedAt = normalizeTimestamp(record.updatedAt) ?? createdAt;
    // 处理重复配置
    let repeatConfig = record.repeatConfig;
    if (!repeatConfig || typeof repeatConfig !== "object") {
      // 向后兼容：如果没有 repeatConfig，根据 repeatDaily 生成
      repeatConfig = {
        mode: record.repeatDaily ? "daily" : "none",
        hours: record.repeatDaily ? 24 : 0
      };
    }

    return {
      id: record.id,
      title,
      content,
      completed: !!record.completed,
      pinned: !!record.pinned,
      startAt,
      repeatDaily: !!record.repeatDaily,
      repeatConfig: repeatConfig,
      createdAt,
      updatedAt,
      // 协作任务相关字段
      isCollaborative: !!record.isCollaborative,
      collaborators: record.collaborators || [],
    };
  }

  function sortTodos(list, referenceTime = Date.now()) {
    const ref = normalizeTimestamp(referenceTime) ?? Date.now();
    return [...list].sort((a, b) => compareByProximity(a, b, ref));
  }

  function compareByProximity(a, b, reference) {
    // 置顶任务优先
    const aPinned = !!a.pinned;
    const bPinned = !!b.pinned;
    if (aPinned && !bPinned) return -1;
    if (!aPinned && bPinned) return 1;
    const aStart = getEffectiveStart(a);
    const bStart = getEffectiveStart(b);
    const aFuture = aStart >= reference;
    const bFuture = bStart >= reference;

    if (aFuture && !bFuture) return -1;
    if (!aFuture && bFuture) return 1;

    if (aFuture && bFuture) {
      const diff = aStart - bStart;
      if (diff !== 0) return diff;
    } else {
      const diff = bStart - aStart;
      if (diff !== 0) return diff;
    }

    const aUpdated = normalizeTimestamp(a.updatedAt) ?? aStart;
    const bUpdated = normalizeTimestamp(b.updatedAt) ?? bStart;
    if (bUpdated !== aUpdated) return bUpdated - aUpdated;
    return String(a.id).localeCompare(String(b.id));
  }

  function getEffectiveStart(todo) {
    return (
      normalizeTimestamp(todo.startAt) ??
      normalizeTimestamp(todo.createdAt) ??
      Date.now()
    );
  }

  function getTodayLabel() {
    try {
      const now = new Date();
      const formatted = new Intl.DateTimeFormat("zh-CN", {
        month: "numeric",
        day: "numeric",
        weekday: "short",
      }).format(now);
      return formatted.replace("星期", "周");
    } catch (error) {
      return "";
    }
  }

  function normalizeTimestamp(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
    return null;
  }

  function toDateTimeInputs(timestamp) {
    const base = normalizeTimestamp(timestamp) ?? Date.now();
    const date = new Date(base);
    const pad = (num) => String(num).padStart(2, "0");
    return {
      dateValue: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
      timeValue: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
    };
  }

  function combineDateAndTime(dateValue, timeValue, fallbackTimestamp = Date.now()) {
    const fallback = normalizeTimestamp(fallbackTimestamp) ?? Date.now();
    if (!dateValue) return fallback;
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
    if (!dateMatch) return fallback;
    const year = Number(dateMatch[1]);
    const monthIndex = Number(dateMatch[2]) - 1;
    const day = Number(dateMatch[3]);
    if (Number.isNaN(year) || Number.isNaN(monthIndex) || Number.isNaN(day)) {
      return fallback;
    }
    const fallbackDate = new Date(fallback);
    let hours = fallbackDate.getHours();
    let minutes = fallbackDate.getMinutes();
    if (timeValue) {
      const timeMatch = /^(\d{2}):(\d{2})$/.exec(timeValue);
      if (timeMatch) {
        const parsedHours = Number(timeMatch[1]);
        const parsedMinutes = Number(timeMatch[2]);
        if (!Number.isNaN(parsedHours) && !Number.isNaN(parsedMinutes)) {
          hours = parsedHours;
          minutes = parsedMinutes;
        }
      }
    }
    const combined = new Date(year, monthIndex, day, hours, minutes, 0, 0);
    if (Number.isNaN(combined.getTime())) {
      return fallback;
    }
    return combined.getTime();
  }

  function startOfDay(timestamp) {
    const base = new Date(normalizeTimestamp(timestamp) ?? Date.now());
    base.setHours(0, 0, 0, 0);
    return base.getTime();
  }

  function alignTimestampToDay(sourceTimestamp, dayStartTimestamp) {
    const source = new Date(normalizeTimestamp(sourceTimestamp) ?? Date.now());
    const target = new Date(normalizeTimestamp(dayStartTimestamp) ?? Date.now());
    target.setHours(source.getHours(), source.getMinutes(), 0, 0);
    return target.getTime();
  }

  function formatDateCompact(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return "";
    const now = new Date();
    const sameYear = date.getFullYear() === now.getFullYear();
    const pad = (num) => String(num).padStart(2, "0");
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    const datePart = sameYear ? `${month}-${day}` : `${date.getFullYear()}-${month}-${day}`;
    return `${datePart} ${hours}:${minutes}`;
  }

  // --- B 方案核心函数 ---
  async function ensurePersistentStorage() {
    try {
      if (!("storage" in navigator) || !("persist" in navigator.storage)) return false;
      const persisted = await navigator.storage.persisted();
      if (persisted) return true;
      const granted = await navigator.storage.persist();
      console.info("[todo] Storage persistence:", granted ? "granted" : "denied");
      return !!granted;
    } catch (e) {
      console.debug("[todo] Storage persistence check failed", e);
      return false;
    }
  }

  function updateStorageKeys(id) {
    storageKey = `${storageKeyBase}:${id}`;
    preferenceKey = `${preferenceKeyBase}:${id}`;
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
  }

  function loadStoredUserId() {
    const raw = localStorage.getItem(userIdKey);
    const normalized = normalizeUserId(raw);
    return isValidUserId(normalized) ? normalized : null;
  }

  function normalizeUserId(value) {
    if (!value || typeof value !== "string") return "";
    return value.trim().toLowerCase();
  }

  function isValidUserId(value) {
    return typeof value === "string" && /^[a-z0-9]{8,}$/.test(value);
  }

  async function loginUserOnServer(id) {
    if (!isValidUserId(id)) {
      return { ok: false, message: "无效的用户 ID" };
    }
    try {
      const response = await fetch(loginEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ user_id: id }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.code) {
        return {
          ok: false,
          message:
            (data && data.msg) || `登录失败（HTTP ${response.status}）`,
        };
      }
      return {
        ok: true,
        exists: !!data.exists,
        userId: data.user_id || id,
      };
    } catch (error) {
      return {
        ok: false,
        message: "网络错误，无法验证用户，请稍后再试。",
        error,
      };
    }
  }

  async function registerUserOnServer(id) {
    if (!isValidUserId(id)) {
      return { ok: false, message: "无效的用户 ID" };
    }
    try {
      const response = await fetch(registerEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ user_id: id }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.code) {
        return {
          ok: false,
          message: (data && data.msg) || `注册失败（HTTP ${response.status}）`,
        };
      }
      return { ok: true, created: !!data.created, userId: data.user_id || id };
    } catch (error) {
      return {
        ok: false,
        message: "网络错误，无法注册用户，请稍后再试。",
        error,
      };
    }
  }

  function hideUserIdOverlay() {
    if (!userIdOverlay) return;

    // 多重保险，确保对话框完全关闭
    userIdOverlay.hidden = true;
    userIdOverlay.style.display = "none";
    userIdOverlay.style.visibility = "hidden";
    userIdOverlay.style.opacity = "0";

    // 清空输入框
    if (userIdInput) {
      userIdInput.value = "";
    }

    // 隐藏错误信息
    if (userIdError) {
      userIdError.hidden = true;
      userIdError.textContent = "";
    }

  }

  function showUserIdOverlay() {
    if (!userIdOverlay) return;

    // 获取提示元素
    const hintNew = document.getElementById('user-id-hint-new');
    const hintSwitch = document.getElementById('user-id-hint-switch');

    // 首次使用，显示注册提示
    if (hintNew) hintNew.hidden = false;
    if (hintSwitch) hintSwitch.hidden = true;

    // 重置所有样式属性，确保显示
    userIdOverlay.hidden = false;
    userIdOverlay.style.display = "grid";
    userIdOverlay.style.visibility = "visible";
    userIdOverlay.style.opacity = "1";

  }
  async function ensureUserId() {
    const localId = "localuser";
    try { localStorage.setItem(userIdKey, localId); } catch (error) {}
    return localId;
  }


  async function promptUserIdFallback(allowCancel, initialValue) {
    let value = initialValue;
    while (true) {
      const input = window.prompt(
        "请输入用户 ID（至少 8 位字母或数字），用于在不同设备间同步待办。",
        value || ""
      );
      if (input == null) {
        if (allowCancel) return null;
        continue;
      }
      const normalized = normalizeUserId(input);
      if (!isValidUserId(normalized)) {
        value = normalized;
        continue;
      }

      const loginResult = await loginUserOnServer(normalized);
      if (loginResult.ok && loginResult.exists) {
        localStorage.setItem(userIdKey, normalized);
        try { await loadUserProfile(normalized); if (typeof updateAllUserDisplays==='function') updateAllUserDisplays(); } catch(e) { console.debug('[todo] post-login(profile) refresh failed', e); }
        return normalized;
      }
      if (!loginResult.ok) {
        alert(loginResult.message || "登录失败，请重试。");
        value = normalized;
        continue;
      }

      const shouldRegister = window.confirm(
        "未找到该用户，是否注册并登录此用户？"
      );
      if (!shouldRegister) {
        value = normalized;
        continue;
      }

      const registerResult = await registerUserOnServer(normalized);
      if (!registerResult.ok) {
        alert(registerResult.message || "注册失败，请重试。");
        value = normalized;
        continue;
      }

      localStorage.setItem(userIdKey, normalized);
      return normalized;
    }
  }

  function openDatabase() {
    if (typeof indexedDB === "undefined") return Promise.resolve(null);
    return new Promise((resolve) => {
      let resolved = false;
      try {
        const request = indexedDB.open(dbName, 1);
        request.onerror = () => {
          if (!resolved) resolve(null);
          resolved = true;
        };
        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains(dbStore)) {
            db.createObjectStore(dbStore, { keyPath: "id" });
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          if (db) {
            db.onversionchange = () => db.close();
          }
          if (!resolved) resolve(db);
          resolved = true;
        };
      } catch (error) {
        console.debug("[todo] IndexedDB open failed", error);
        if (!resolved) resolve(null);
        resolved = true;
      }
    });
  }

  function readAllFromIndexedDB(db) {
    return new Promise((resolve) => {
      if (!db) return resolve([]);
      try {
        const tx = db.transaction(dbStore, "readonly");
        const store = tx.objectStore(dbStore);
        const request = store.getAll();
        request.onsuccess = () => {
          const result = Array.isArray(request.result) ? normalizeTodoCollection(request.result) : [];
          resolve(result);
        };
        request.onerror = () => resolve([]);
      } catch (error) {
        console.debug("[todo] IndexedDB read failed", error);
        resolve([]);
      }
    });
  }

  function writeAllToIndexedDB(db, payload) {
    return new Promise((resolve) => {
      if (!db) return resolve(false);
      try {
        const tx = db.transaction(dbStore, "readwrite");
        const store = tx.objectStore(dbStore);
        tx.oncomplete = () => resolve(true);
        tx.onabort = tx.onerror = () => resolve(false);
        const clearRequest = store.clear();
        clearRequest.onerror = () => {
          tx.abort();
        };
        clearRequest.onsuccess = () => {
          for (const entry of payload) {
            store.put(entry);
          }
        };
      } catch (error) {
        console.debug("[todo] IndexedDB write failed", error);
        resolve(false);
      }
    });
  }

  // =============== 新增：导出/导入 + 指示器 ===============

  // =============== 新增：导出/导入 + 指示器 ===============
  function mountBackupControls() {
    let container = document.getElementById("backup-controls");
    if (container) {
      updateUserBadge();
      setPersistIndicator(persistedStatus);
      return;
    }

    container = document.createElement("div");
    container.id = "backup-controls";
    container.setAttribute("role", "group");
    container.style.margin = "8px 0";
    container.style.display = "flex";
    container.style.gap = "8px";
    container.style.flexWrap = "wrap";
    container.style.alignItems = "center";

    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.id = "export-btn";
    exportBtn.textContent = "导出";
    exportBtn.title = "导出JSON数据";

    const importBtn = document.createElement("button");
    importBtn.type = "button";
    importBtn.id = "import-btn";
    importBtn.textContent = "导入";
    importBtn.title = "导入JSON数据";

    const switchBtn = document.createElement("button");
    switchBtn.type = "button";
    switchBtn.id = "switch-user-btn";
    switchBtn.textContent = "切换用户";

    // 存储指示器已隐藏

    const userBadge = document.createElement("span");
    userBadge.id = "user-badge";
    userBadge.className = "user-badge";

    // 退出按钮
    const logoutBtn = document.createElement("button");
    logoutBtn.type = "button";
    logoutBtn.id = "logout-btn";
    logoutBtn.className = "logout-btn";
    logoutBtn.textContent = "退出";
    logoutBtn.title = "退出当前用户";

    exportBtn.addEventListener("click", () => exportTodos(todos));
    importBtn.addEventListener("click", async () => {
      const incoming = await selectAndReadJsonArray();
      if (!incoming) return;
      const merged = mergeImportedTodos(todos, incoming);
      if (JSON.stringify(merged) !== JSON.stringify(todos)) {
        todos = merged;
        await saveAndRender();
      }
    });

    switchBtn.addEventListener("click", async () => {
      const nextId = await ensureUserId(true);
      if (!nextId || nextId === userId) return;

      // 显示加载指示器
      document.body.classList.add("loading");
      const switchStartTime = Date.now();

      try {
        userId = nextId;
        nicknamePrompted = false;  // 重置提示标记，新用户可以收到昵称设置提示
        updateStorageKeys(userId);
        await loadUserProfile(nextId);  // 新增：重新加载用户资料
        await hydrateData();
        todos = sortTodos(todos);
        const refreshed = refreshRepeatingTodos();
        if (refreshed) {
          todos = sortTodos(todos);
          await saveTodos();
        }
        render();
        setPersistIndicator(persistedStatus);
        updateUserBadge();
        updateAllUserDisplays();  // 新增：更新所有用户显示
        resetStartInputs();
      } finally {
        // 确保加载指示器至少显示500ms
        const switchDuration = Date.now() - switchStartTime;
        const minDisplayTime = 500;
        if (switchDuration < minDisplayTime) {
          await new Promise(resolve => setTimeout(resolve, minDisplayTime - switchDuration));
        }

        // 移除加载指示器
        document.body.classList.remove("loading");
      }
    });

    // 退出按钮点击事件
    logoutBtn.addEventListener("click", () => {
      if (!confirm("确定要退出当前用户吗？\n\n退出后需要重新输入用户ID登录。")) return;

      // 清除本地存储的用户ID
      localStorage.removeItem("todo-app-user-id");
      localStorage.removeItem("todo-app-user-nickname");

      // 刷新页面，触发重新登录流程
      window.location.reload();
    });

    container.appendChild(exportBtn);
    container.appendChild(importBtn);
    container.appendChild(switchBtn);
    // container.appendChild(indicator); // 已隐藏存储指示器
    container.appendChild(userBadge);
    container.appendChild(logoutBtn);

    // 手机端：将 .filters 也添加到 backup-controls 容器中
    if (window.innerWidth <= 720 && filters) {
      container.appendChild(filters);
    }

    // 将 backup-controls 插入到 collapsible-controls 内部
    const collapsibleControls = document.getElementById('collapsible-controls');
    if (collapsibleControls) {
      // 插入到 collapsible-controls 的末尾
      collapsibleControls.appendChild(container);
    } else if (filters && filters.parentElement && window.innerWidth > 720) {
      filters.parentElement.insertBefore(container, filters.nextSibling);
    } else if (form && form.parentElement) {
      form.parentElement.insertBefore(container, form.nextSibling);
    } else if (todoList && todoList.parentElement) {
      todoList.parentElement.insertBefore(container, todoList);
    } else {
      document.body.insertBefore(container, document.body.firstChild);
    }

    setPersistIndicator(persistedStatus);
    updateUserBadge();
  }

  function setPersistIndicator(status) {
    const el = document.getElementById("persist-indicator");
    if (!el) {
      updateUserBadge();
      return;
    }
    if (status == null) {
      el.textContent = "存储: 检测中";
      el.style.opacity = "0.85";
    } else {
      el.textContent = status ? "存储: 已持久化" : "存储: 非持久化";
      el.style.opacity = status ? "1" : "0.85";
    }
    updateUserBadge();
  }

  function updateUserBadge() {
    const badge = document.getElementById("user-badge");
    if (!badge) return;
    // 显示昵称，而不是ID
    badge.textContent = userNickname ? `昵称: ${userNickname}` : "昵称: 未设置";

    // 添加提示样式
    badge.style.cursor = "pointer";
    badge.title = "双击或长按编辑昵称";

    // 设置双击/长按编辑事件（只设置一次）
    if (!badge.dataset.editListenerAdded) {
      badge.dataset.editListenerAdded = "true";
      setupNicknameEditListeners(badge);
    }
  }

  /**
   * 设置昵称badge的双击和长按事件监听器
   */
  function setupNicknameEditListeners(badge) {
    let longPressTimer = null;
    let isLongPress = false;

    // 双击事件（电脑端）
    badge.addEventListener("dblclick", (e) => {
      e.preventDefault();
      openQuickNicknameEdit();
    });

    // 触摸开始（手机端长按）
    badge.addEventListener("touchstart", (e) => {
      isLongPress = false;
      longPressTimer = setTimeout(() => {
        isLongPress = true;
        // 震动反馈（如果支持）
        if (navigator.vibrate) {
          navigator.vibrate(50);
        }
        openQuickNicknameEdit();
      }, 500); // 500ms长按
    });

    // 触摸结束
    badge.addEventListener("touchend", () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
      }
    });

    // 触摸取消
    badge.addEventListener("touchcancel", () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
      }
    });
  }

  /**
   * 快速编辑昵称（内联编辑）
   */
  function openQuickNicknameEdit() {
    const badge = document.getElementById("user-badge");
    if (!badge) return;

    // 创建输入框
    const input = document.createElement("input");
    input.type = "text";
    input.value = userNickname || "";
    input.placeholder = "输入昵称";
    input.maxLength = 32;
    input.style.cssText = `
      width: 150px;
      padding: 4px 8px;
      border: 2px solid #4CAF50;
      border-radius: 4px;
      font-size: 14px;
      outline: none;
    `;

    // 保存原始文本
    const originalText = badge.textContent;

    // 替换badge内容为输入框
    badge.textContent = "";
    badge.appendChild(input);
    input.focus();
    input.select();

    // 保存函数
    const saveNickname = async () => {
      const newNickname = input.value.trim();

      // 恢复显示
      badge.removeChild(input);
      badge.textContent = "昵称: 保存中...";

      if (!newNickname) {
        alert("昵称不能为空");
        updateUserBadge();
        return;
      }

      if (newNickname === userNickname) {
        // 没有改变
        updateUserBadge();
        return;
      }

      try {
        // 调用API更新昵称
        const response = await fetch(`${nicknameEndpoint}?user_id=${userId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nickname: newNickname })
        });

        const data = await response.json();

        if (response.ok && data.status === "ok") {
          userNickname = newNickname;
          updateUserBadge();
          updateAllUserDisplays();

          // 显示成功提示
          showToast("昵称更新成功", "success");
        } else {
          throw new Error(data.msg || "更新失败");
        }
      } catch (error) {
        console.error("[todo] Failed to update nickname:", error);
        alert(`昵称更新失败: ${error.message}`);
        updateUserBadge();
      }
    };

    // 取消函数
    const cancel = () => {
      badge.removeChild(input);
      updateUserBadge();
    };

    // 回车保存
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveNickname();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });

    // 失去焦点时保存
    input.addEventListener("blur", () => {
      // 延迟执行，避免与其他事件冲突
      setTimeout(saveNickname, 100);
    });
  }

  function exportTodos(items) {
    try {
      const blob = new Blob([
        JSON.stringify(
          items.map((t) => ({
            id: t.id,
            title: t.title,
            content: t.content || "",
            completed: !!t.completed,
            startAt: t.startAt ?? t.createdAt,
            repeatDaily: !!t.repeatDaily,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt || t.createdAt,
          })),
          null,
          2
        ),
      ], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `todos-backup-${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      console.warn("Export failed", e);
    }
  }

  function selectAndReadJsonArray() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json";
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const data = JSON.parse(String(reader.result));
            if (!Array.isArray(data)) return resolve(null);
            const normalized = data
              .filter((it) => it && typeof it.id === "string")
              .map((item) => ({
                id: String(item.id),
                title: typeof item.title === "string" ? item.title : String(item.title ?? ""),
                content: typeof item.content === "string" ? item.content : "",
                completed: !!item.completed,
                startAt: normalizeTimestamp(item.startAt) ?? normalizeTimestamp(item.createdAt) ?? Date.now(),
                repeatDaily: !!item.repeatDaily,
                createdAt: normalizeTimestamp(item.createdAt) ?? Date.now(),
                updatedAt: normalizeTimestamp(item.updatedAt) ?? normalizeTimestamp(item.createdAt) ?? Date.now(),
              }));
            resolve(normalized);
          } catch (e) {
            console.warn("Import parse failed", e);
            resolve(null);
          }
        };
        reader.readAsText(file);
      };
      input.click();
    });
  }

  function mergeImportedTodos(local, incoming) {
    const map = new Map();
    for (const t of local) {
      map.set(t.id, { ...t });
    }
    for (const t of incoming) {
      const prev = map.get(t.id);
      if (!prev) {
        map.set(t.id, { ...t });
        continue;
      }
      // 取更新时间较新的那一条
      const prevTime = normalizeTimestamp(prev.updatedAt) ?? normalizeTimestamp(prev.createdAt) ?? 0;
      const nextTime = normalizeTimestamp(t.updatedAt) ?? normalizeTimestamp(t.createdAt) ?? 0;
      map.set(t.id, nextTime >= prevTime ? { ...prev, ...t } : prev);
    }
    return [...map.values()].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  }

    // === 新增函数：显示添加成功提示 ===
    function showAddSuccessToast(message) {
      const toast = document.createElement("div");
      toast.textContent = message;
      toast.style.position = "fixed";
      toast.style.bottom = "20px";
      toast.style.left = "50%";
      toast.style.transform = "translateX(-50%)";
      toast.style.background = "#4caf50";
      toast.style.color = "#fff";
      toast.style.padding = "10px 20px";
      toast.style.borderRadius = "6px";
      toast.style.boxShadow = "0 2px 6px rgba(0,0,0,0.2)";
      toast.style.opacity = "0";
      toast.style.transition = "opacity 0.4s ease";
      toast.style.zIndex = "9999";

      document.body.appendChild(toast);
      requestAnimationFrame(() => (toast.style.opacity = "1"));

      setTimeout(() => {
        toast.style.opacity = "0";
        setTimeout(() => toast.remove(), 500);
      }, 2000);
    }

  // ========= 管理员功能 =========
  const adminLoginBtn = document.querySelector('#admin-login-btn');
  const adminOverlay = document.querySelector('#admin-overlay');
  const adminLoginForm = document.querySelector('#admin-login-form');
  const adminPasswordInput = document.querySelector('#admin-password-input');
  const adminError = document.querySelector('#admin-error');
  const adminCancelBtn = document.querySelector('#admin-cancel');
  const adminPanelOverlay = document.querySelector('#admin-panel-overlay');
  const adminCloseBtn = document.querySelector('#admin-close-btn');
  const adminUserList = document.querySelector('#admin-user-list');
  const adminTotalUsers = document.querySelector('#admin-total-users');

  if (adminLoginBtn) {
    adminLoginBtn.addEventListener('click', showAdminLogin);
  }

  if (adminCancelBtn) {
    adminCancelBtn.addEventListener('click', hideAdminLogin);
  }

  if (adminLoginForm) {
    adminLoginForm.addEventListener('submit', handleAdminLogin);
  }

  if (adminCloseBtn) {
    adminCloseBtn.addEventListener('click', hideAdminPanel);
  }

  function showAdminLogin() {
    if (adminOverlay) {
      adminOverlay.hidden = false;
      adminPasswordInput.value = '';
      adminPasswordInput.focus();
      if (adminError) adminError.hidden = true;
    }
  }

  function hideAdminLogin() {
    if (adminOverlay) {
      adminOverlay.hidden = true;
      adminPasswordInput.value = '';
      if (adminError) adminError.hidden = true;
    }
  }

  async function handleAdminLogin(event) {
    event.preventDefault();
    const password = adminPasswordInput.value.trim();

    if (!password) {
      showAdminError('请输入密码');
      return;
    }

    try {
      const response = await fetch(resolveApiEndpoints().basePath + '/api/admin/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'same-origin',
        body: JSON.stringify({ password }),
      });

      const data = await response.json();

      if (response.ok && data.status === 'ok') {
        hideAdminLogin();
        showAdminPanel();
      } else {
        showAdminError(data.msg || '登录失败');
      }
    } catch (error) {
      console.error('Admin login error:', error);
      showAdminError('网络错误，请稍后重试');
    }
  }

  function showAdminError(message) {
    if (adminError) {
      adminError.textContent = message;
      adminError.hidden = false;
    }
  }

  async function showAdminPanel() {
    if (adminPanelOverlay) {
      adminPanelOverlay.hidden = false;
      await loadAdminUsers();
    }
  }

  function hideAdminPanel() {
    if (adminPanelOverlay) {
      adminPanelOverlay.hidden = true;
    }
  }

  async function loadAdminUsers() {
    try {
      const response = await fetch(resolveApiEndpoints().basePath + '/api/admin/users', {
        method: 'GET',
        credentials: 'same-origin',
      });

      if (!response.ok) {
        throw new Error('Failed to load users');
      }

      const data = await response.json();
      displayAdminUsers(data.users || []);
    } catch (error) {
      console.error('Load users error:', error);
      if (adminUserList) {
        adminUserList.innerHTML = '<p style="text-align: center; color: var(--danger);">加载失败，请重试</p>';
      }
    }
  }

  function displayAdminUsers(users) {
    if (!adminUserList) return;

    if (adminTotalUsers) {
      adminTotalUsers.textContent = `总用户数: ${users.length}`;
    }

    if (users.length === 0) {
      adminUserList.innerHTML = `
        <p style="text-align: center; color: var(--muted); margin: 2rem 0;">暂无用户</p>
        <button class="admin-add-user-btn" onclick="showAddUserDialog()">➕ 新增用户</button>
      `;
      return;
    }

    const userListHtml = users.map(user => {
      // 格式化创建时间
      const createdDate = user.created_at ? new Date(user.created_at).toLocaleDateString('zh-CN') : '未知';
      const nickname = user.nickname || '未设置';

      return `
        <div class="admin-user-item" data-user-id="${user.user_id}">
          <div class="admin-user-info">
            <div class="admin-user-id">
              <span class="user-id-text">${user.user_id}</span>
              ${user.nickname ? `<span class="user-nickname-badge">${nickname}</span>` : '<span class="user-nickname-empty">未设置昵称</span>'}
            </div>
            <div class="admin-user-stats">
              <span class="stat-item">📝 任务数: ${user.task_count}</span>
              <span class="stat-separator">|</span>
              <span class="stat-item">✅ 已完成: ${user.completed_count}</span>
              <span class="stat-separator">|</span>
              <span class="stat-item">📅 注册: ${createdDate}</span>
            </div>
          </div>
          <div class="admin-user-actions">
            <button class="admin-view-btn" onclick="viewUserData('${user.user_id}', '${nickname}')">👁️ 浏览</button>
            <button class="admin-edit-btn" onclick="showEditUserDialog('${user.user_id}', '${user.nickname || ''}')">✏️ 编辑</button>
            <button class="admin-delete-btn" onclick="deleteAdminUser('${user.user_id}', '${nickname}')">🗑️ 删除</button>
          </div>
        </div>
      `;
    }).join('');

    adminUserList.innerHTML = `
      <div class="admin-add-user-container">
        <button class="admin-add-user-btn" onclick="showAddUserDialog()">➕ 新增用户</button>
      </div>
      ${userListHtml}
    `;
  }

  window.deleteAdminUser = async function(userId, nickname = '未设置') {
    const displayName = nickname !== '未设置' ? `${nickname} (${userId})` : userId;
    if (!confirm(`确认删除用户 "${displayName}" 及其所有任务吗？此操作无法恢复。`)) {
      return;
    }

    try {
      const response = await fetch(resolveApiEndpoints().basePath + `/api/admin/users/${userId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });

      if (!response.ok) {
        throw new Error('Failed to delete user');
      }

      const data = await response.json();
      alert(data.msg || '删除成功');
      await loadAdminUsers();
    } catch (error) {
      console.error('Delete user error:', error);
      alert('删除失败，请重试');
    }
  };

  // 新增用户对话框
  window.showAddUserDialog = function() {
    const userId = prompt('请输入新用户的ID（8~64位字母或数字）：');
    if (!userId) return;

    const nickname = prompt('请输入昵称（可选，最多32个字符）：') || '';

    createAdminUser(userId, nickname);
  };

  // 编辑用户对话框
  window.showEditUserDialog = function(userId, currentNickname) {
    const nickname = prompt(`编辑用户 ${userId} 的昵称：`, currentNickname || '');
    if (nickname === null) return; // 用户取消

    updateAdminUser(userId, nickname);
  };

  // 创建用户
  async function createAdminUser(userId, nickname) {
    try {
      const response = await fetch(resolveApiEndpoints().basePath + '/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ user_id: userId, nickname: nickname })
      });

      const data = await response.json();

      if (!response.ok) {
        alert(data.msg || data.error || '创建失败');
        return;
      }

      alert(data.msg || '用户创建成功');
      await loadAdminUsers();
    } catch (error) {
      console.error('Create user error:', error);
      alert('创建失败，请重试');
    }
  }

  // 更新用户
  async function updateAdminUser(userId, nickname) {
    try {
      const response = await fetch(resolveApiEndpoints().basePath + `/api/admin/users/${userId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ nickname: nickname })
      });

      const data = await response.json();

      if (!response.ok) {
        alert(data.msg || data.error || '更新失败');
        return;
      }

      alert(data.msg || '用户信息更新成功');
      await loadAdminUsers();
    } catch (error) {
      console.error('Update user error:', error);
      alert('更新失败，请重试');
    }
  }

  // 浏览用户数据
  window.viewUserData = async function(userId, nickname = '未设置') {
    try {
      const response = await fetch(resolveApiEndpoints().basePath + `/api/admin/users/${userId}/view`, {
        method: 'GET',
        credentials: 'same-origin',
      });

      if (!response.ok) {
        const data = await response.json();
        alert(data.msg || data.error || '获取用户数据失败');
        return;
      }

      const data = await response.json();
      showUserDataDialog(data);
    } catch (error) {
      console.error('View user data error:', error);
      alert('获取用户数据失败，请重试');
    }
  };

  // 显示用户数据对话框
  function showUserDataDialog(userData) {
    const overlay = document.getElementById('user-data-view-overlay');
    if (!overlay) return;

    const userIdEl = document.getElementById('view-user-id');
    const nicknameEl = document.getElementById('view-user-nickname');
    const taskCountEl = document.getElementById('view-task-count');
    const taskListEl = document.getElementById('view-task-list');

    if (userIdEl) userIdEl.textContent = userData.user_id;
    if (nicknameEl) nicknameEl.textContent = userData.nickname || '未设置';
    if (taskCountEl) taskCountEl.textContent = userData.tasks.length;

    // 渲染任务列表
    if (taskListEl) {
      if (userData.tasks.length === 0) {
        taskListEl.innerHTML = '<p style="text-align: center; color: var(--muted); padding: 2rem;">该用户暂无任务</p>';
      } else {
        const tasksHtml = userData.tasks.map(task => {
          const completedClass = task.completed ? 'completed' : '';
          const completedIcon = task.completed ? '✅' : '⬜';
          const startDate = task.startAt ? new Date(task.startAt).toLocaleString('zh-CN') : '未设置';

          // 使用renderMarkdown渲染任务内容
          const content = task.content ? `<div class="task-content">${renderMarkdown(task.content)}</div>` : '';

          return `
            <div class="view-task-item ${completedClass}">
              <div class="view-task-header">
                <span class="view-task-status">${completedIcon}</span>
                <span class="view-task-title">${escapeHtml(task.title)}</span>
              </div>
              ${content}
              <div class="view-task-meta">
                <span>📅 开始时间: ${startDate}</span>
              </div>
            </div>
          `;
        }).join('');
        taskListEl.innerHTML = tasksHtml;
      }
    }

    overlay.hidden = false;
  }

  // HTML转义函数
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // 关闭用户数据浏览对话框
  const userDataViewCloseBtn = document.getElementById('user-data-view-close');
  if (userDataViewCloseBtn) {
    userDataViewCloseBtn.addEventListener('click', function() {
      const overlay = document.getElementById('user-data-view-overlay');
      if (overlay) overlay.hidden = true;
    });
  }

  // ========= 昵称相关功能 =========

  /**
   * 加载用户资料（包括昵称）
   */
  async function loadUserProfile(uid) {
    if (!uid) {
      console.warn('[todo] loadUserProfile called with empty uid');
      return;
    }

    try {
      const response = await fetch(`${profileEndpoint}?user_id=${uid}`, {
        method: 'GET',
        credentials: 'same-origin',
      });

      if (response.ok) {
        const data = await response.json();
        userNickname = data.nickname || null;
        updateAllUserDisplays();

        // 如果没有昵称且尚未提示过，提示用户设置（只提示一次）
        if ((!userNickname || !userNickname.trim()) && !nicknamePrompted) {
          promptSetNickname();
        }
      }
    } catch (error) {
      console.debug('[todo] Failed to load user profile', error);
    }
  }

  /**
   * 更新所有显示用户信息的地方
   */
  function updateAllUserDisplays() {
    // 1. 底部用户徽章（最重要）
    updateUserBadge();

    // 2. 分享提示中的昵称
    if (myNicknameSpan) {
      myNicknameSpan.textContent = userNickname || '未设置';
    }

    // 3. 切换用户对话框中的信息
    if (currentNickname) {
      currentNickname.textContent = userNickname || '未设置';
    }
    if (currentUserId) {
      currentUserId.textContent = userId || '未登录';
    }

    // 4. 显示/隐藏当前用户信息区域
    if (currentUserInfo) {
      // 仅在显示切换用户对话框时显示
      currentUserInfo.hidden = false;
    }

  }

  /**
   * 提示用户设置昵称（首次登录且没有昵称时）
   * 使用独立窗口方式，避免与登录框冲突
   */
  function promptSetNickname() {

    // 标记已提示过，避免重复弹窗
    nicknamePrompted = true;

    // 延迟打开昵称窗口，确保登录窗口已完全关闭
    // 等待 DOM 更新和任何可能的动画完成
    setTimeout(() => {
      openNicknameWindow(true);
    }, 500);  // 500ms 延迟确保登录窗口已完全关闭
  }

  /**
   * 打开昵称设置窗口（独立窗口）
   * @param {boolean} isRequired - 是否必须设置（首次设置时为 true）
   */
  function openNicknameWindow(isRequired = false) {
    if (!userId) {
      console.error('[todo] Cannot open nickname window: userId is null');
      return;
    }

    const { basePath } = resolveApiEndpoints();
    const params = new URLSearchParams({
      user_id: userId,
      required: isRequired.toString(),
      base_path: basePath
    });

    const url = `${basePath}/nickname?${params.toString()}`;

    // 打开新窗口（小窗口）
    const width = 500;
    const height = 450;
    const left = (window.screen.width - width) / 2;
    const top = (window.screen.height - height) / 2;

    const nicknameWindow = window.open(
      url,
      'nicknameWindow',
      `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
    );

    if (!nicknameWindow) {
      console.error('[todo] Failed to open nickname window (popup blocked?)');
      alert('无法打开昵称设置窗口，请检查浏览器弹窗拦截设置');
      return;
    }

    // 聚焦新窗口
    nicknameWindow.focus();
  }

  /**
   * 旧版对话框函数（已废弃，保留以防兼容性问题）
   * @deprecated 使用 openNicknameWindow() 代替
   */
  function openNicknameDialog(isRequired = false) {
    console.warn('[todo] openNicknameDialog() is deprecated, use openNicknameWindow() instead');
    openNicknameWindow(isRequired);
  }

  /**
   * 复制用户ID到剪贴板
   */
  async function copyUserIdToClipboard() {
    if (!userId) return;

    try {
      await navigator.clipboard.writeText(userId);
      alert('用户ID已复制到剪贴板');
    } catch (err) {
      // 降级方案
      const input = document.createElement('input');
      input.value = userId;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      alert('用户ID已复制');
    }
  }

  /**
   * 初始化昵称相关的事件处理器
   */
  function initializeNicknameHandlers() {
    // 新版：监听来自昵称窗口的消息
    window.addEventListener('message', (event) => {
      // 安全检查：确保消息来源合法
      if (event.origin !== window.location.origin) {
        return;
      }

      if (event.data.type === 'nickname-updated') {
        // 昵称更新成功
        const newNickname = event.data.nickname;

        userNickname = newNickname;
        updateAllUserDisplays();
        updateUserBadge();
      } else if (event.data.type === 'nickname-cancelled') {
        // 用户取消了昵称设置
      }
    });

    // 复制ID按钮
    if (copyUserIdBtn) {
      copyUserIdBtn.addEventListener('click', copyUserIdToClipboard);
    }
  }

  /**
   * 修改切换用户函数，支持显示当前用户信息
   */
  function showUserIdDialogForSwitch() {
    if (!userIdOverlay) return;

    // 获取提示元素
    const hintNew = document.getElementById('user-id-hint-new');
    const hintSwitch = document.getElementById('user-id-hint-switch');

    // 根据是否有当前用户显示不同的提示
    const hasUser = !!userId;
    if (hasUser) {
      // 已有用户，显示切换提示
      if (hintNew) hintNew.hidden = true;
      if (hintSwitch) hintSwitch.hidden = false;

      // 显示当前用户信息
      if (currentUserInfo) {
        currentUserInfo.hidden = false;
      }

      // 更新当前用户信息
      updateAllUserDisplays();
    } else {
      // 首次使用，显示注册提示
      if (hintNew) hintNew.hidden = false;
      if (hintSwitch) hintSwitch.hidden = true;

      // 隐藏当前用户信息
      if (currentUserInfo) {
        currentUserInfo.hidden = true;
      }
    }

    // 清空输入框
    if (userIdInput) {
      userIdInput.value = '';
    }

    // 显示对话框（重置所有样式属性，确保显示）
    userIdOverlay.hidden = false;
    userIdOverlay.style.display = "grid";
    userIdOverlay.style.visibility = "visible";
    userIdOverlay.style.opacity = "1";

    if (userIdInput) {
      userIdInput.focus();
    }

  }

  // ============ 协作共享功能已迁移到独立页面 /todo/collaborate ============


})();

// 强制修复手机端文字竖向显示问题
document.addEventListener("DOMContentLoaded", function() {
  if (window.innerWidth <= 720) {
    // 定期检查并修复竖向文字
    function fixVerticalText() {
      // 修复按钮文字
      const buttons = document.querySelectorAll('.share-btn, .edit-btn, .delete-btn, .fullscreen-toggle-btn, .fullscreen-toggle-btn-bottom');
      buttons.forEach(btn => {
        btn.style.writingMode = 'horizontal-tb';
        btn.style.webkitWritingMode = 'horizontal-tb';
        btn.style.textOrientation = 'mixed';
        btn.style.whiteSpace = 'nowrap';
      });
    }

    // 立即执行一次
    fixVerticalText();

    // 延迟执行（等待动态内容加载）
    setTimeout(fixVerticalText, 500);
    setTimeout(fixVerticalText, 1000);

    // 监听DOM变化
    const observer = new MutationObserver(fixVerticalText);
    observer.observe(document.body, { childList: true, subtree: true });
  }
});

// 修复手机端复选框布局为横向
if (window.innerWidth <= 720) {
  setTimeout(function() {
    const checkboxes = document.querySelectorAll('.todo-item .checkbox');
    checkboxes.forEach(cb => {
      cb.style.display = 'inline-flex';
      cb.style.flexDirection = 'row';
      cb.style.alignItems = 'center';
      cb.style.gap = '3px';
    });
  }, 100);
}


// ==================== 批量获取附件数量 ====================
(function() {
  console.log('[AttachmentBatch] Loaded');

  async function batchFetchAttachmentCounts() {
    try {
      const buttons = document.querySelectorAll('.attachment-btn[data-todo-id]');
      console.log('[AttachmentBatch] Found', buttons.length, 'buttons');
      if (buttons.length === 0) return;

      const todoIds = [];
      buttons.forEach(btn => {
        const id = btn.getAttribute('data-todo-id');
        if (id) todoIds.push(id);
      });
      console.log('[AttachmentBatch] Fetching counts for', todoIds.length, 'tasks');

      const startTime = performance.now();
      const userId = localStorage.getItem('todo-app-user-id') || '';
      const response = await fetch('/todo/api/batch-attachment-counts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, todo_ids: todoIds })
      });

      if (!response.ok) {
        console.error('[AttachmentBatch] Request failed:', response.status);
        return;
      }

      const result = await response.json();
      const counts = result.data.counts || {};
      const endTime = performance.now();
      console.log('[AttachmentBatch] ✓ Received counts in', Math.round(endTime - startTime), 'ms');
      console.log('[AttachmentBatch] Sample:', Object.keys(counts).slice(0, 3), '...');

      let updated = 0;
      buttons.forEach(btn => {
        const id = btn.getAttribute('data-todo-id');
        if (id && counts[id] !== undefined) {
          const span = btn.querySelector('.attachment-count');
          if (span) {
            const count = counts[id];
            span.textContent = count;
            span.classList.toggle('empty', count === 0);
            span.classList.toggle('has-files', count > 0);
            updated++;
          }
        }
      });
      console.log('[AttachmentBatch] ✓ Updated', updated, '/', todoIds.length, 'badges');

    } catch (error) {
      console.error('[AttachmentBatch] Error:', error);
    }
  }

  // 暴露到全局
  window.batchFetchAttachmentCounts = batchFetchAttachmentCounts;

  // 防抖和去重机制
  let debounceTimer = null;
  let isUpdating = false;
  let lastButtonCount = 0;

  const debouncedBatchFetch = () => {
    // 如果正在更新中，跳过
    if (isUpdating) return;

    // 清除之前的定时器
    if (debounceTimer) clearTimeout(debounceTimer);

    // 设置新的定时器
    debounceTimer = setTimeout(async () => {
      isUpdating = true;
      const currentButtonCount = document.querySelectorAll('.attachment-btn[data-todo-id]').length;
      lastButtonCount = currentButtonCount;
      await batchFetchAttachmentCounts();
      isUpdating = false;
    }, 100); // 100ms 防抖（优化：更快响应附件变化）
  };

  // 页面加载完成后自动执行一次
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      console.log('[AttachmentBatch] Auto-executing on DOMContentLoaded');
      setTimeout(debouncedBatchFetch, 300);
    });
  } else {
    console.log('[AttachmentBatch] Auto-executing immediately');
    setTimeout(debouncedBatchFetch, 300);
  }

  // 监听任务列表变化（仅监听 childList，不监听 subtree）
  const observer = new MutationObserver((mutations) => {
    // 只关注新增/删除任务项，不关注属性变化
    const hasRelevantChanges = mutations.some(mutation => {
      return mutation.type === 'childList' &&
             (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0);
    });

    if (hasRelevantChanges) {
      debouncedBatchFetch();
    }
  });

  // 等待 todo-list 元素出现后开始监听
  const startObserving = () => {
    const todoList = document.getElementById('todo-list');
    if (todoList) {
      // 只监听直接子节点的增删，不监听所有后代节点
      observer.observe(todoList, { childList: true, subtree: false });
      console.log('[AttachmentBatch] Observer attached (debounced)');
    } else {
      setTimeout(startObserving, 100);
    }
  };

  startObserving();

})();
