const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const CLIENT_ID_KEY = "recipeFinderClientId";

function getClientId() {
  const existing = localStorage.getItem(CLIENT_ID_KEY);
  if (existing) return existing;
  const generated =
    window.crypto?.randomUUID?.().replaceAll("-", "") ||
    `client_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(CLIENT_ID_KEY, generated);
  return generated;
}

const state = {
  clientId: getClientId(),
  allItems: [],
  visibleItems: [],
  selectedId: "",
  activeCategory: "全部",
  activeDifficulty: "全部",
  activeTab: "content",
  servingCount: 2,
  compact: false,
  favorites: new Set(JSON.parse(localStorage.getItem("recipeFavorites") || "[]")),
  notes: JSON.parse(localStorage.getItem("recipeNotes") || "{}"),
  lastQuery: "",
};

const elements = {
  searchForm: $("#searchForm"),
  queryInput: $("#queryInput"),
  resultList: $("#resultList"),
  resultTitle: $("#resultTitle"),
  resultStatus: $("#resultStatus"),
  sortSelect: $("#sortSelect"),
  typeSelect: $("#typeSelect"),
  cuisineSelect: $("#cuisineSelect"),
  servingSelect: $("#servingSelect"),
  favoriteOnly: $("#favoriteOnly"),
  structuredOnly: $("#structuredOnly"),
  crawlBanner: $("#crawlBanner"),
  crawlMessage: $("#crawlMessage"),
  detailTitle: $("#detailTitle"),
  detailMeta: $("#detailMeta"),
  ingredientList: $("#ingredientList"),
  stepList: $("#stepList"),
  sourceLinks: $("#sourceLinks"),
  crawlSteps: $("#crawlSteps"),
  tipCard: $("#tipCard"),
  microTip: $("#microTip"),
  saveButton: $("#saveButton"),
  servingCount: $("#servingCount"),
  compareList: $("#compareList"),
  nutritionGrid: $("#nutritionGrid"),
  noteArea: $("#noteArea"),
  noteStatus: $("#noteStatus"),
  updatedAt: $("#updatedAt"),
  toast: $("#toast"),
  importPanel: $("#importPanel"),
  importToggle: $("#importToggle"),
  bulkButton: $("#bulkButton"),
  refreshCrawlStatus: $("#refreshCrawlStatus"),
  crawlPanelStatus: $("#crawlPanelStatus"),
  crawlPanelMeta: $("#crawlPanelMeta"),
  sourceStatus: $("#sourceStatus"),
  crawlTopics: $("#crawlTopics"),
};

function hashId(value) {
  let hash = 0;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(index);
    hash |= 0;
  }
  return `r_${Math.abs(hash)}`;
}

function normalizeRecipe(item, index = 0) {
  const sourceUrl = item.sourceUrl || item.canonicalUrl || "";
  return {
    id: hashId(`${sourceUrl}${item.title}${index}`),
    title: item.title || "未命名食譜",
    source: item.source || hostName(sourceUrl) || "未知來源",
    sourceUrl,
    canonicalUrl: item.canonicalUrl || sourceUrl,
    description: item.description || "此來源可供比對，請打開原文確認完整內容。",
    image: item.image || "",
    ingredients: Array.isArray(item.ingredients) ? item.ingredients.filter(Boolean) : [],
    steps: Array.isArray(item.steps) ? item.steps.filter(Boolean) : [],
    servings: item.servings || "",
    time: item.time || "",
    difficulty: item.difficulty || "普通",
    tags: Array.isArray(item.tags) ? item.tags.filter(Boolean) : [],
    quality: Number(item.quality || 50),
    extractedFrom: item.extractedFrom || "unknown",
    warning: item.warning || "",
  };
}

function hostName(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => elements.toast.classList.remove("show"), 3200);
}

async function loadUserState() {
  try {
    const response = await fetch(`/api/user-state?clientId=${encodeURIComponent(state.clientId)}`);
    if (!response.ok) throw new Error("State request failed");
    const payload = await response.json();
    const remote = payload.state || {};
    const localFavorites = JSON.parse(localStorage.getItem("recipeFavorites") || "[]");
    const localNotes = JSON.parse(localStorage.getItem("recipeNotes") || "{}");
    state.favorites = new Set([...(remote.favorites || []), ...localFavorites]);
    state.notes = { ...(remote.notes || {}), ...localNotes };
    persistUserState(false);
  } catch (error) {
    console.warn("Using local recipe state only.", error);
  }
}

function persistUserState(debounce = true) {
  localStorage.setItem("recipeFavorites", JSON.stringify([...state.favorites]));
  localStorage.setItem("recipeNotes", JSON.stringify(state.notes));
  window.clearTimeout(persistUserState.timer);
  const sync = async () => {
    try {
      await fetch("/api/user-state", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: state.clientId,
          state: {
            favorites: [...state.favorites],
            notes: state.notes,
          },
        }),
      });
    } catch (error) {
      console.warn("Recipe state sync failed.", error);
    }
  };
  if (debounce) {
    persistUserState.timer = window.setTimeout(sync, 500);
  } else {
    sync();
  }
}

function setLoading(isLoading, message = "") {
  document.body.classList.toggle("is-loading", isLoading);
  elements.crawlBanner.hidden = !isLoading;
  if (message) elements.crawlMessage.textContent = message;
}

function startCrawlTicker() {
  const messages = ["正在讀取 MD 網址清單...", "正在擷取來源網頁...", "正在整理材料與做法...", "正在更新料理索引..."];
  let index = 0;
  setLoading(true, messages[index]);
  return window.setInterval(() => {
    index = Math.min(index + 1, messages.length - 1);
    elements.crawlMessage.textContent = messages[index];
  }, 1400);
}

async function loadInitialRecipes() {
  const response = await fetch("/api/search");
  const payload = await response.json();
  renderCrawlPanel(payload.crawl);
  setRecipes(payload.items || [], payload.warning || buildStatus(payload));
}

async function performSearch(query) {
  const trimmed = query.trim();
  state.lastQuery = trimmed;
  const ticker = startCrawlTicker();
  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "搜尋失敗");
    renderCrawlPanel(payload.crawl);
    setRecipes(payload.items || [], payload.warning || buildStatus(payload));
    if (payload.warning) showToast(payload.warning);
  } catch (error) {
    showToast(error.message || "搜尋時發生錯誤");
  } finally {
    window.clearInterval(ticker);
    setLoading(false);
  }
}

function buildStatus(payload) {
  if (payload.mode === "content") return `已載入 MD 網址清單索引，共 ${payload.crawl?.itemCount || payload.items?.length || 0} 筆整理結果。`;
  if (payload.mode === "empty") return "MD 網址清單索引沒有符合的結果。";
  if (payload.mode === "sample") return "尚未從 MD 網址清單建立索引，目前先顯示示範資料。";
  return "結果已更新。";
}

function setRecipes(items, statusText) {
  state.allItems = items.map(normalizeRecipe);
  state.selectedId = state.allItems[0]?.id || "";
  state.servingCount = getBaseServing(selectedRecipe()) || 2;
  elements.resultStatus.textContent = statusText;
  applyFilters();
}

function selectedRecipe() {
  return state.visibleItems.find((item) => item.id === state.selectedId) || state.visibleItems[0] || state.allItems[0];
}

function recipeMatchesCategory(recipe, value) {
  if (value === "全部") return true;
  const haystack = `${recipe.title} ${recipe.description} ${recipe.tags.join(" ")} ${recipe.ingredients.join(" ")}`;
  return haystack.includes(value);
}

function getMinutes(recipe) {
  const text = `${recipe.time} ${recipe.description}`;
  const minutes = text.match(/(\d{1,3})\s*(?:分鐘|分|min)/i);
  if (minutes) return Number(minutes[1]);
  const hours = text.match(/(\d(?:\.\d)?)\s*(?:小時|hour|hr)/i);
  if (hours) return Number(hours[1]) * 60;
  return 999;
}

function passesTime(recipe) {
  const selected = $$('input[name="time"]:checked').map((item) => item.value);
  if (!selected.length) return true;
  const minutes = getMinutes(recipe);
  return selected.some((value) => {
    if (value === "15") return minutes <= 15;
    if (value === "30") return minutes <= 30;
    if (value === "60") return minutes > 30 && minutes <= 60;
    return minutes > 60;
  });
}

function passesServing(recipe) {
  const value = elements.servingSelect.value;
  if (value === "全部") return true;
  const base = getBaseServing(recipe);
  if (value === "1") return base <= 1;
  if (value === "2") return base >= 2 && base <= 3;
  return base >= 4;
}

function getBaseServing(recipe) {
  const match = String(recipe?.servings || "").match(/\d+/);
  if (match) return Number(match[0]);
  return 2;
}

function applyFilters() {
  const typeValue = elements.typeSelect.value;
  const cuisineValue = elements.cuisineSelect.value;
  const structuredOnly = elements.structuredOnly.checked;
  const favoriteOnly = elements.favoriteOnly.checked;

  let items = state.allItems.filter((recipe) => {
    const matchesType = recipeMatchesCategory(recipe, typeValue);
    const matchesChip = recipeMatchesCategory(recipe, state.activeCategory);
    const matchesCuisine = recipeMatchesCategory(recipe, cuisineValue);
    const matchesDifficulty = state.activeDifficulty === "全部" || recipe.difficulty === state.activeDifficulty;
    const hasStructure = recipe.ingredients.length > 0 && recipe.steps.length > 0;
    const isFavorite = state.favorites.has(recipe.id);
    return (
      matchesType &&
      matchesChip &&
      matchesCuisine &&
      matchesDifficulty &&
      passesTime(recipe) &&
      passesServing(recipe) &&
      (!structuredOnly || hasStructure) &&
      (!favoriteOnly || isFavorite)
    );
  });

  items = sortRecipes(items);
  state.visibleItems = items;
  if (!items.some((item) => item.id === state.selectedId)) {
    state.selectedId = items[0]?.id || "";
  }
  renderResults();
  renderDetail();
}

function sortRecipes(items) {
  const sorted = [...items];
  const mode = elements.sortSelect.value;
  if (mode === "quality") sorted.sort((a, b) => b.quality - a.quality);
  if (mode === "time") sorted.sort((a, b) => getMinutes(a) - getMinutes(b));
  if (mode === "ingredients") sorted.sort((a, b) => a.ingredients.length - b.ingredients.length);
  if (mode === "source") sorted.sort((a, b) => a.source.localeCompare(b.source, "zh-Hant"));
  return sorted;
}

function renderResults() {
  elements.resultTitle.textContent = `找到 ${state.visibleItems.length} 個結果`;
  if (!state.visibleItems.length) {
    elements.resultList.innerHTML = `<div class="empty-detail"><p>沒有符合篩選的結果。</p></div>`;
    return;
  }

  elements.resultList.innerHTML = state.visibleItems
    .map((recipe) => {
      const isActive = recipe.id === state.selectedId;
      const isFavorite = state.favorites.has(recipe.id);
      const compact = state.compact ? " compact" : "";
      return `
        <button class="result-card${isActive ? " active" : ""}${compact}" type="button" data-id="${recipe.id}">
          <span class="thumb">${renderThumb(recipe)}</span>
          <span>
            <h2>${escapeHtml(recipe.title)}</h2>
            <span class="recipe-meta">
              <span>${escapeHtml(recipe.source)}</span>
              <span>${escapeHtml(recipe.time || "時間未標示")}</span>
              <span>${escapeHtml(recipe.servings || "份量未標示")}</span>
            </span>
            <p>${escapeHtml(recipe.description)}</p>
          </span>
          <span class="quality">
            <span class="quality-badge">${qualityLabel(recipe.quality)}</span>
            <span class="quality-score">${Math.round(recipe.quality)}%</span>
            <svg class="bookmark${isFavorite ? " active" : ""}" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z"/></svg>
          </span>
        </button>
      `;
    })
    .join("");

  $$(".result-card").forEach((card) => {
    card.addEventListener("click", () => {
      state.selectedId = card.dataset.id;
      state.servingCount = getBaseServing(selectedRecipe()) || 2;
      renderResults();
      renderDetail();
    });
  });
}

function renderThumb(recipe) {
  if (recipe.image) {
    return `<img src="${escapeHtml(recipe.image)}" alt="${escapeHtml(recipe.title)}" loading="lazy" referrerpolicy="no-referrer" />`;
  }
  const text = recipe.title.replace(/\s+/g, "").slice(0, 2) || "食";
  return `<span>${escapeHtml(text)}</span>`;
}

function qualityLabel(score) {
  if (score >= 85) return "高品質";
  if (score >= 68) return "中高品質";
  if (score >= 50) return "可參考";
  return "需確認";
}

function iconSvg(path) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
}

function renderDetail() {
  const recipe = selectedRecipe();
  $("#emptyDetail").hidden = Boolean(recipe);
  $("#recipeDetail").hidden = !recipe;
  if (!recipe) return;

  elements.detailTitle.textContent = recipe.title;
  elements.detailMeta.innerHTML = [
    metaPill("M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71", recipe.source),
    metaPill("M12 6v6l4 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", recipe.time || "時間未標示"),
    metaPill("M16 21v-2a4 4 0 0 0-8 0v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", recipe.servings || "份量未標示"),
    `<span class="simple-pill">${escapeHtml(recipe.difficulty)}</span>`,
  ].join("");

  elements.saveButton.classList.toggle("save", true);
  elements.saveButton.innerHTML = `${iconSvg("M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z")}${state.favorites.has(recipe.id) ? "已收藏" : "收藏"}`;
  elements.servingCount.textContent = state.servingCount;
  renderIngredients(recipe);
  renderSteps(recipe);
  renderSources(recipe);
  renderCompareList();
  renderNutrition(recipe);
  renderNotes(recipe);
  renderCrawlSteps(recipe);
  elements.updatedAt.textContent = `最後更新：${new Date().toLocaleString("zh-TW", { hour12: false })}`;
}

function metaPill(path, text) {
  return `<span class="meta-pill">${iconSvg(path)}${escapeHtml(text)}</span>`;
}

function renderIngredients(recipe) {
  if (!recipe.ingredients.length) {
    elements.ingredientList.innerHTML = `<li>此頁未抽取到明確材料，請打開來源確認。</li>`;
  } else {
    const base = getBaseServing(recipe) || 2;
    const ratio = state.servingCount / base;
    elements.ingredientList.innerHTML = recipe.ingredients
      .map((item) => `<li>${escapeHtml(scaleIngredient(item, ratio))}</li>`)
      .join("");
  }
  elements.tipCard.innerHTML = `<strong>小秘訣</strong>${escapeHtml(buildTip(recipe))}`;
}

function scaleIngredient(text, ratio) {
  if (!Number.isFinite(ratio) || Math.abs(ratio - 1) < 0.05) return text;
  return text.replace(/(\d+(?:\.\d+)?)(?=\s*(顆|個|支|根|瓣|片|大匙|小匙|匙|杯|碗|克|g|ml|毫升|公克|包|罐|份))/gi, (match) => {
    const scaled = Number(match) * ratio;
    return scaled % 1 === 0 ? String(scaled) : scaled.toFixed(1).replace(/\.0$/, "");
  });
}

function buildTip(recipe) {
  const text = `${recipe.title} ${recipe.ingredients.join(" ")} ${recipe.steps.join(" ")}`;
  if (/番茄|tomato/i.test(text)) return "番茄先炒到出汁，酸甜味會更完整。";
  if (/咖哩|curry/i.test(text)) return "咖哩塊關火後再拌入，較不容易黏底。";
  if (/牛肉|beef/i.test(text)) return "牛肉汆燙後洗掉浮沫，湯頭會更清澈。";
  if (/甜點|鮮奶油|蛋糕|tiramisu/i.test(text)) return "冷藏時間拉長一點，香氣和口感會更融合。";
  return "先備好材料再開火，能減少手忙腳亂與過度烹煮。";
}

function renderSteps(recipe) {
  if (!recipe.steps.length) {
    elements.stepList.innerHTML = `<li>此頁未抽取到明確步驟，請打開來源確認完整做法。</li>`;
  } else {
    elements.stepList.innerHTML = recipe.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("");
  }
  const micro = recipe.steps.length >= 4 ? "步驟較完整，適合照順序操作。" : "步驟偏少，建議搭配來源原文確認火候。";
  elements.microTip.innerHTML = `<strong>小撇步</strong>${micro}`;
}

function renderSources(recipe) {
  const links = [recipe, ...state.visibleItems.filter((item) => item.id !== recipe.id)].slice(0, 5);
  elements.sourceLinks.innerHTML = links
    .map((item) => {
      const url = item.sourceUrl || item.canonicalUrl;
      if (!url || url.includes("example.com")) {
        return `<span class="meta-row">${escapeHtml(item.source)}</span>`;
      }
      return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.source)} ${iconSvg("M7 17 17 7M8 7h9v9")}</a>`;
    })
    .join("");
}

function renderCrawlSteps(recipe) {
  const sourceType = {
    "json-ld": "解析結構化食譜",
    heuristic: "使用頁面文字推斷",
    sample: "載入示範資料",
    fallback: "外部來源失敗，以備援食譜補位",
    "link-only": "保留來源連結",
    error: "抽取失敗",
  }[recipe.extractedFrom] || "整理結果";
  const warning = recipe.warning ? `提醒：${recipe.warning}` : "完成";
  elements.crawlSteps.innerHTML = [
    "開始處理來源",
    recipe.sourceUrl ? "抓取網頁內容" : "讀取本機資料",
    sourceType,
    recipe.ingredients.length ? "擷取材料與份量" : "材料需人工確認",
    recipe.steps.length ? "擷取料理步驟" : "做法需人工確認",
    warning,
  ]
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
}

function renderCompareList() {
  if (!state.visibleItems.length) {
    elements.compareList.innerHTML = "";
    return;
  }
  elements.compareList.innerHTML = state.visibleItems
    .map(
      (item) => `
      <div class="compare-row">
        <div>
          <h4>${escapeHtml(item.title)}</h4>
          <p>${escapeHtml(item.source)} · ${escapeHtml(item.time || "時間未標示")} · ${item.ingredients.length} 項材料 · ${item.steps.length} 個步驟</p>
        </div>
        <span class="quality-score">${Math.round(item.quality)}%</span>
      </div>
    `,
    )
    .join("");
}

function renderNutrition(recipe) {
  const text = `${recipe.title} ${recipe.ingredients.join(" ")}`;
  const hasMeat = /(雞|牛|豬|魚|蝦|肉|egg|蛋)/i.test(text);
  const hasCream = /(奶油|鮮奶油|起司|乳酪|mascarpone|cheese)/i.test(text);
  const vegetableCount = (text.match(/番茄|洋蔥|青菜|蘿蔔|馬鈴薯|菇|蔥|蒜|菜/g) || []).length;
  const baseCalories = 220 + recipe.ingredients.length * 22 + (hasCream ? 160 : 0) + (hasMeat ? 90 : 0);
  const cards = [
    ["熱量", `約 ${baseCalories} kcal`, "依材料粗估，實際以用量為準"],
    ["蛋白質", hasMeat ? "中高" : "中低", hasMeat ? "含蛋、肉類或海鮮" : "可加豆腐或蛋補足"],
    ["蔬菜量", vegetableCount >= 3 ? "充足" : "可增加", vegetableCount >= 3 ? "蔬菜元素明顯" : "搭配青菜更均衡"],
    ["調味強度", /(醬油|鹽|咖哩|味噌|辣)/.test(text) ? "中等" : "清爽", "可依口味減鹽或加酸味"],
  ];
  elements.nutritionGrid.innerHTML = cards
    .map(([title, value, desc]) => `<div class="nutrition-card"><h4>${title}</h4><strong>${value}</strong><p>${desc}</p></div>`)
    .join("");
}

function renderNotes(recipe) {
  elements.noteArea.value = state.notes[recipe.id] || "";
  elements.noteStatus.textContent = "";
}

function switchTab(tab) {
  state.activeTab = tab;
  $$(".tabs button").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  $$(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `tab-${tab}`));
  $(".detail-pane")?.scrollTo({ top: 0, behavior: "auto" });
}

function toggleFavorite(recipe = selectedRecipe()) {
  if (!recipe) return;
  if (state.favorites.has(recipe.id)) {
    state.favorites.delete(recipe.id);
    showToast("已移除收藏");
  } else {
    state.favorites.add(recipe.id);
    showToast("已加入收藏");
  }
  persistUserState();
  renderResults();
  renderDetail();
}

function formatDateTime(value) {
  if (!value) return "尚未執行";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "尚未執行";
  return date.toLocaleString("zh-TW", { hour12: false });
}

function renderSourceStatus(crawl = {}) {
  if (!elements.sourceStatus) return;
  const rows = [
    {
      label: `來源檔：${crawl.sourceFile || "recipe-urls.md"}`,
      ready: true,
    },
    {
      label: `網址數：${crawl.sourceUrlCount || 0}`,
      ready: Number(crawl.sourceUrlCount || 0) > 0,
    },
  ];
  elements.sourceStatus.innerHTML = rows
    .map((row) => `<span class="${row.ready ? "ready" : "pending"}">${escapeHtml(row.label)}</span>`)
    .join("");
}

function renderCrawlPanel(crawl) {
  if (!crawl || !elements.crawlPanelStatus) return;
  const running = crawl.status === "running";
  elements.crawlPanelStatus.textContent = running
    ? "正在依 MD 網址清單更新內容"
    : `MD 網址清單已整理 ${crawl.itemCount || 0} 筆食譜`;
  elements.crawlPanelMeta.textContent = `上次完成：${formatDateTime(crawl.lastFinishedAt)}｜更新方式：手動按內容更新`;
  renderSourceStatus(crawl);
  elements.crawlTopics.innerHTML = (crawl.sourceUrls || crawl.queries || [])
    .map((url) => `<span>${escapeHtml(url)}</span>`)
    .join("");
  if (crawl.lastError) {
    elements.crawlPanelMeta.textContent += `｜最近提醒：${crawl.lastError}`;
  }
}

async function fetchCrawlStatus() {
  try {
    const response = await fetch("/api/content/status");
    const payload = await response.json();
    renderCrawlPanel(payload.crawl);
    return payload.crawl;
  } catch (error) {
    showToast(error.message || "內容狀態讀取失敗");
    return null;
  }
}

async function runContentUpdateNow() {
  const ticker = startCrawlTicker();
  try {
    const response = await fetch("/api/content/update", { method: "POST" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "內容更新啟動失敗");
    renderCrawlPanel(payload.crawl);
    showToast("內容更新已開始，系統會依 recipe-urls.md 擷取。");
    pollCrawlUntilIdle();
  } catch (error) {
    showToast(error.message || "內容更新啟動失敗");
  } finally {
    window.clearInterval(ticker);
    setLoading(false);
  }
}

async function pollCrawlUntilIdle() {
  const crawl = await fetchCrawlStatus();
  if (crawl?.status === "running") {
    window.setTimeout(pollCrawlUntilIdle, 2500);
    return;
  }
  await loadInitialRecipes();
}

function bindEvents() {
  elements.searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    performSearch(elements.queryInput.value);
  });

  $("#crawlButton").addEventListener("click", runContentUpdateNow);
  $("#applyFilters").addEventListener("click", applyFilters);
  $("#clearFilters").addEventListener("click", () => {
    state.activeCategory = "全部";
    state.activeDifficulty = "全部";
    elements.typeSelect.value = "全部";
    elements.cuisineSelect.value = "全部";
    elements.servingSelect.value = "全部";
    elements.favoriteOnly.checked = false;
    elements.structuredOnly.checked = false;
    $$('input[name="time"]').forEach((input) => {
      input.checked = input.value === "30";
    });
    $$("#categoryChips .chip").forEach((button) => button.classList.toggle("active", button.dataset.value === "全部"));
    $$("#difficultyControl button").forEach((button) => button.classList.toggle("active", button.dataset.value === "全部"));
    applyFilters();
  });

  ["change", "input"].forEach((eventName) => {
    [elements.typeSelect, elements.cuisineSelect, elements.servingSelect, elements.favoriteOnly, elements.structuredOnly, elements.sortSelect].forEach((control) =>
      control.addEventListener(eventName, applyFilters),
    );
  });

  $$('input[name="time"]').forEach((input) => input.addEventListener("change", applyFilters));

  $$("#categoryChips .chip").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeCategory = button.dataset.value;
      $$("#categoryChips .chip").forEach((item) => item.classList.toggle("active", item === button));
      applyFilters();
    });
  });

  $$("#difficultyControl button").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeDifficulty = button.dataset.value;
      $$("#difficultyControl button").forEach((item) => item.classList.toggle("active", item === button));
      applyFilters();
    });
  });

  $("#compactToggle").addEventListener("click", () => {
    state.compact = !state.compact;
    renderResults();
  });

  elements.saveButton.addEventListener("click", () => toggleFavorite());
  $("#increaseServing").addEventListener("click", () => {
    state.servingCount = Math.min(12, state.servingCount + 1);
    renderDetail();
  });
  $("#decreaseServing").addEventListener("click", () => {
    state.servingCount = Math.max(1, state.servingCount - 1);
    renderDetail();
  });

  $$(".tabs button").forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.tab)));

  $("#saveNoteButton").addEventListener("click", () => {
    const recipe = selectedRecipe();
    if (!recipe) return;
    state.notes[recipe.id] = elements.noteArea.value;
    persistUserState();
    elements.noteStatus.textContent = "已儲存";
    showToast("筆記已儲存");
  });

  $("#shareButton").addEventListener("click", async () => {
    const recipe = selectedRecipe();
    if (!recipe) return;
    const text = `${recipe.title}\n${recipe.sourceUrl || ""}`;
    try {
      if (navigator.share) await navigator.share({ title: recipe.title, text, url: recipe.sourceUrl });
      else await navigator.clipboard.writeText(text);
      showToast("分享內容已準備好");
    } catch {
      showToast("分享已取消");
    }
  });

  $("#printButton").addEventListener("click", () => window.print());

  elements.importToggle.addEventListener("click", () => {
    const hidden = !elements.importPanel.hidden;
    elements.importPanel.hidden = hidden;
    elements.importToggle.setAttribute("aria-expanded", String(!hidden));
    if (!hidden) fetchCrawlStatus();
  });
  elements.bulkButton.addEventListener("click", runContentUpdateNow);
  elements.refreshCrawlStatus.addEventListener("click", fetchCrawlStatus);

  $("#helpButton").addEventListener("click", () => {
    showToast("把食譜網址貼進 recipe-urls.md，按內容更新後系統會依清單重新擷取。");
  });
}

bindEvents();

async function init() {
  await loadUserState();
  await fetchCrawlStatus();
  await loadInitialRecipes();
}

init().catch((error) => showToast(error.message || "初始資料載入失敗"));
