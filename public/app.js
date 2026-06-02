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
  compact: false,
  favorites: new Set(JSON.parse(localStorage.getItem("recipeFavorites") || "[]")),
  notes: JSON.parse(localStorage.getItem("recipeNotes") || "{}"),
  lastQuery: "",
  sourceTotal: 0,
  currentPage: 1,
  pageSize: 20,
};

const ALL_FILTER_VALUE = "全部";
const CUISINE_OPTIONS = [
  [ALL_FILTER_VALUE, "全部菜系"],
  ["日式", "日式"],
  ["台式", "台式"],
  ["中式", "中式"],
  ["韓式", "韓式"],
  ["東南亞", "東南亞"],
  ["西式", "西式"],
  ["甜點烘焙", "甜點 / 烘焙"],
  ["飲品", "飲品"],
];

const CUISINE_ALIASES = {
  日式: ["日式", "日本", "和風", "味醂", "唐揚", "照燒", "壽喜燒", "味噌", "tasty-note"],
  台式: ["台式", "台灣", "三杯", "滷肉", "肉燥", "鹽酥", "ytower", "icook.tw"],
  中式: ["中式", "川菜", "粵菜", "上海", "紅燒", "清蒸", "宮保", "麻婆"],
  韓式: ["韓式", "韓國", "泡菜", "韓式辣醬", "年糕", "部隊鍋"],
  東南亞: ["泰式", "越式", "南洋", "咖哩", "椰奶", "檸檬草", "魚露"],
  西式: ["西式", "義式", "法式", "美式", "pasta", "risotto", "steak", "cheese", "butter"],
  甜點烘焙: ["甜點", "烘焙", "蛋糕", "餅乾", "麵包", "布丁", "tiramisu", "巧克力"],
  飲品: ["飲品", "果汁", "茶", "咖啡", "奶昔", "smoothie"],
};

const elements = {
  searchForm: $("#searchForm"),
  queryInput: $("#queryInput"),
  resultList: $("#resultList"),
  resultTitle: $("#resultTitle"),
  resultStatus: $("#resultStatus"),
  pagination: $("#pagination"),
  prevPage: $("#prevPage"),
  nextPage: $("#nextPage"),
  pageStatus: $("#pageStatus"),
  sortSelect: $("#sortSelect"),
  typeSelect: $("#typeSelect"),
  cuisineSelect: $("#cuisineSelect"),
  favoriteOnly: $("#favoriteOnly"),
  structuredOnly: $("#structuredOnly"),
  crawlBanner: $("#crawlBanner"),
  crawlMessage: $("#crawlMessage"),
  detailTitle: $("#detailTitle"),
  detailMeta: $("#detailMeta"),
  ingredientList: $("#ingredientList"),
  stepList: $("#stepList"),
  tipCard: $("#tipCard"),
  microTip: $("#microTip"),
  saveButton: $("#saveButton"),
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
    image: resolveRecipeImage(item, sourceUrl),
    ingredients: Array.isArray(item.ingredients) ? item.ingredients.filter(Boolean) : [],
    steps: Array.isArray(item.steps) ? item.steps.filter(Boolean) : [],
    servings: item.servings || "",
    time: item.time || "",
    difficulty: item.difficulty || "普通",
    tags: Array.isArray(item.tags) ? item.tags.filter(Boolean) : [],
    cuisine: item.cuisine || inferCuisineFromRecipe(item),
    quality: Number(item.quality || 50),
    extractedFrom: item.extractedFrom || "unknown",
    warning: item.warning || "",
  };
}

function resolveRecipeImage(item = {}, baseUrl = "") {
  const candidates = [
    item.image,
    item.imageUrl,
    item.thumbnail,
    item.thumbnailUrl,
    item.photo,
    item.photos,
    item.images,
    item.primaryImage,
  ];
  for (const candidate of candidates) {
    const url = coerceImageUrl(candidate);
    if (url) return absolutizeImageUrl(url, baseUrl);
  }
  return "";
}

function coerceImageUrl(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = coerceImageUrl(item);
      if (url) return url;
    }
    return "";
  }
  if (typeof value === "object") {
    return coerceImageUrl(value.url || value.src || value.contentUrl || value["@id"]);
  }
  return "";
}

function absolutizeImageUrl(url, baseUrl = "") {
  try {
    return new URL(url, baseUrl || window.location.href).toString();
  } catch {
    return "";
  }
}

function hostName(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isAllFilter(value) {
  const text = String(value || "").trim();
  return !text || text === ALL_FILTER_VALUE || text.includes("全部") || text.includes("券");
}

function configureCuisineOptions() {
  if (!elements.cuisineSelect) return;
  elements.cuisineSelect.innerHTML = CUISINE_OPTIONS
    .map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`)
    .join("");
}

function removeSourceSections() {
  document.querySelector('.tabs button[data-tab="sources"]')?.remove();
  document.querySelector("#tab-sources")?.remove();
  document.querySelector(".source-box")?.remove();
}

function inferCuisineFromRecipe(recipe = {}) {
  const text = [
    recipe.title,
    recipe.description,
    recipe.source,
    recipe.sourceUrl,
    ...(Array.isArray(recipe.tags) ? recipe.tags : []),
    ...(Array.isArray(recipe.ingredients) ? recipe.ingredients : []),
  ].join(" ");
  const lower = text.toLowerCase();
  let best = "其他";
  let bestScore = 0;
  Object.entries(CUISINE_ALIASES).forEach(([cuisine, aliases]) => {
    const score = aliases.reduce((total, alias) => {
      const needle = alias.toLowerCase();
      return total + (lower.includes(needle) ? (needle.length >= 4 ? 2 : 1) : 0);
    }, 0);
    if (score > bestScore) {
      best = cuisine;
      bestScore = score;
    }
  });
  return best;
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
  const messages = ["正在讀取來源清單...", "正在擷取來源網頁...", "正在整理材料與做法...", "正在更新料理索引..."];
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
  setRecipes(payload.items || [], payload.warning || buildStatus(payload), payload);
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
    setRecipes(payload.items || [], payload.warning || buildStatus(payload), payload);
    if (payload.warning) showToast(payload.warning);
  } catch (error) {
    showToast(error.message || "搜尋時發生錯誤");
  } finally {
    window.clearInterval(ticker);
    setLoading(false);
  }
}

function buildStatus(payload) {
  if (payload.mode === "content") return `已載入來源清單索引，共 ${payload.crawl?.itemCount || payload.items?.length || 0} 筆整理結果。`;
  if (payload.mode === "empty") return "來源清單索引沒有符合的結果。";
  if (payload.mode === "sample") return "尚未從來源清單建立索引，目前先顯示示範資料。";
  return "結果已更新。";
}

function setRecipes(items, statusText, payload = {}) {
  state.allItems = items.map(normalizeRecipe);
  state.sourceTotal = Number(payload.crawl?.itemCount || items.length || 0);
  state.lastQuery = String(payload.query || "").trim();
  state.selectedId = state.allItems[0]?.id || "";
  state.currentPage = 1;
  elements.resultStatus.textContent = statusText;
  applyFilters();
}

function selectedRecipe() {
  return state.visibleItems.find((item) => item.id === state.selectedId) || state.visibleItems[0] || state.allItems[0];
}

function recipeMatchesCategory(recipe, value) {
  if (isAllFilter(value)) return true;
  const haystack = `${recipe.title} ${recipe.description} ${recipe.tags.join(" ")} ${recipe.ingredients.join(" ")}`;
  return haystack.includes(value);
}

function recipeMatchesCuisine(recipe, value) {
  if (isAllFilter(value)) return true;
  if (recipe.cuisine === value) return true;
  const aliases = CUISINE_ALIASES[value] || [value];
  const haystack = `${recipe.cuisine} ${recipe.title} ${recipe.description} ${recipe.source} ${recipe.sourceUrl} ${recipe.tags.join(" ")} ${recipe.ingredients.join(" ")}`.toLowerCase();
  return aliases.some((alias) => haystack.includes(String(alias).toLowerCase()));
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

function applyFilters(options = {}) {
  const resetPage = options.resetPage !== false;
  const typeValue = elements.typeSelect.value;
  const cuisineValue = elements.cuisineSelect.value;
  const structuredOnly = elements.structuredOnly.checked;
  const favoriteOnly = elements.favoriteOnly.checked;

  let items = state.allItems.filter((recipe) => {
    const matchesType = recipeMatchesCategory(recipe, typeValue);
    const matchesChip = recipeMatchesCategory(recipe, state.activeCategory);
    const matchesCuisine = recipeMatchesCuisine(recipe, cuisineValue);
    const matchesDifficulty = isAllFilter(state.activeDifficulty) || recipe.difficulty === state.activeDifficulty;
    const hasStructure = recipe.ingredients.length > 0 && recipe.steps.length > 0;
    const isFavorite = state.favorites.has(recipe.id);
    return (
      matchesType &&
      matchesChip &&
      matchesCuisine &&
      matchesDifficulty &&
      passesTime(recipe) &&
      (!structuredOnly || hasStructure) &&
      (!favoriteOnly || isFavorite)
    );
  });

  items = sortRecipes(items);
  state.visibleItems = items;
  if (resetPage) state.currentPage = 1;
  state.currentPage = clampPage(state.currentPage);
  if (resetPage || !items.some((item) => item.id === state.selectedId)) {
    state.selectedId = pageItems()[0]?.id || items[0]?.id || "";
  }
  renderResults();
  renderDetail();
}

function totalPages() {
  return Math.max(1, Math.ceil(state.visibleItems.length / state.pageSize));
}

function clampPage(page) {
  return Math.min(Math.max(1, Number(page) || 1), totalPages());
}

function pageItems() {
  const start = (state.currentPage - 1) * state.pageSize;
  return state.visibleItems.slice(start, start + state.pageSize);
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

function activeFilterLabels() {
  const labels = [];
  if (!isAllFilter(elements.typeSelect.value)) labels.push(elements.typeSelect.options[elements.typeSelect.selectedIndex]?.text || elements.typeSelect.value);
  if (!isAllFilter(elements.cuisineSelect.value)) labels.push(elements.cuisineSelect.options[elements.cuisineSelect.selectedIndex]?.text || elements.cuisineSelect.value);
  if (!isAllFilter(state.activeCategory)) labels.push(state.activeCategory);
  if (!isAllFilter(state.activeDifficulty)) labels.push(state.activeDifficulty);
  const times = $$('input[name="time"]:checked').map((input) => input.parentElement?.textContent?.trim()).filter(Boolean);
  labels.push(...times);
  if (elements.favoriteOnly.checked) labels.push("只看收藏");
  if (elements.structuredOnly.checked) labels.push("只看可抽取材料步驟");
  return labels;
}

function renderResultStatus() {
  const total = state.sourceTotal || state.allItems.length || state.visibleItems.length;
  const filters = activeFilterLabels();
  const hasQuery = Boolean(state.lastQuery);
  if (hasQuery) {
    const filterText = filters.length ? `，並套用「${filters.join("、")}」篩選` : "";
    elements.resultStatus.textContent = `目前搜尋「${state.lastQuery}」找到 ${state.visibleItems.length} 筆${filterText}；來源清單共有 ${total} 筆。清空搜尋即可查看全部。`;
    return;
  }
  if (filters.length) {
    elements.resultStatus.textContent = `目前套用「${filters.join("、")}」篩選，顯示 ${state.visibleItems.length} 筆；來源清單共有 ${total} 筆。`;
    return;
  }
  elements.resultStatus.textContent = `已載入來源清單索引，共 ${total} 筆整理結果。`;
}

function renderResults() {
  const pages = totalPages();
  const currentItems = pageItems();
  elements.resultTitle.textContent = `找到 ${state.visibleItems.length} 個結果`;
  renderResultStatus();
  if (!state.visibleItems.length) {
    elements.resultList.innerHTML = `<div class="empty-detail"><p>沒有符合篩選的結果。</p></div>`;
    renderPagination();
    return;
  }

  elements.resultList.innerHTML = currentItems
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

  $$(".result-card img").forEach((image) => {
    image.addEventListener("error", () => {
      image.hidden = true;
      const fallback = image.nextElementSibling;
      if (fallback) fallback.hidden = false;
    });
  });

  $$(".result-card").forEach((card) => {
    card.addEventListener("click", () => {
      state.selectedId = card.dataset.id;
      renderResults();
      renderDetail();
    });
  });
  renderPagination(pages, currentItems.length);
}

function renderPagination(pages = totalPages(), currentCount = pageItems().length) {
  if (!elements.pagination) return;
  const total = state.visibleItems.length;
  const start = total ? (state.currentPage - 1) * state.pageSize + 1 : 0;
  const end = total ? start + currentCount - 1 : 0;
  elements.pagination.hidden = total <= state.pageSize;
  elements.prevPage.disabled = state.currentPage <= 1;
  elements.nextPage.disabled = state.currentPage >= pages;
  elements.pageStatus.textContent = total
    ? `第 ${state.currentPage} / ${pages} 頁，顯示 ${start}-${end} 筆，共 ${total} 筆`
    : "沒有結果";
}

function goToPage(page) {
  state.currentPage = clampPage(page);
  const currentItems = pageItems();
  state.selectedId = currentItems[0]?.id || state.visibleItems[0]?.id || "";
  renderResults();
  renderDetail();
}

function renderThumb(recipe) {
  const fallback = recipe.title.replace(/\s+/g, "").slice(0, 2) || "食";
  if (recipe.image) {
    const proxyUrl = `/api/image?url=${encodeURIComponent(recipe.image)}`;
    return `
      <img src="${escapeHtml(proxyUrl)}" alt="${escapeHtml(recipe.title)}" loading="lazy" referrerpolicy="no-referrer" />
      <span class="thumb-fallback" hidden>${escapeHtml(fallback)}</span>
    `;
  }
  return `<span class="thumb-fallback">${escapeHtml(fallback)}</span>`;
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
    `<span class="simple-pill">${escapeHtml(recipe.difficulty)}</span>`,
  ].join("");

  elements.saveButton.classList.toggle("save", true);
  elements.saveButton.innerHTML = `${iconSvg("M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z")}${state.favorites.has(recipe.id) ? "已收藏" : "收藏"}`;
  renderIngredients(recipe);
  renderSteps(recipe);
  renderNutrition(recipe);
  renderNotes(recipe);
  elements.updatedAt.textContent = `最後更新：${new Date().toLocaleString("zh-TW", { hour12: false })}`;
}

function metaPill(path, text) {
  return `<span class="meta-pill">${iconSvg(path)}${escapeHtml(text)}</span>`;
}

function renderIngredients(recipe) {
  if (!recipe.ingredients.length) {
    elements.ingredientList.innerHTML = `<li>此頁未抽取到明確材料，請打開來源確認。</li>`;
  } else {
    elements.ingredientList.innerHTML = recipe.ingredients
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join("");
  }
  elements.tipCard.innerHTML = `<strong>小秘訣</strong>${escapeHtml(buildTip(recipe))}`;
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
    recipe.ingredients.length ? "擷取材料內容" : "材料需人工確認",
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
  const nutrition = estimateNutrition(recipe);
  const analysis = analyzeNutrition(nutrition);
  const rows = [
    ["熱量", nutrition.total.calories, "大卡"],
    ["蛋白質", nutrition.total.protein, "公克"],
    ["脂肪", nutrition.total.fat, "公克"],
    ["飽和脂肪", nutrition.total.saturatedFat, "公克"],
    ["反式脂肪", nutrition.total.transFat, "公克"],
    ["碳水化合物", nutrition.total.carbs, "公克"],
    ["糖", nutrition.total.sugar, "公克"],
    ["鈉", nutrition.total.sodium, "毫克"],
  ];
  elements.nutritionGrid.innerHTML = `
    <div class="nutrition-panel">
      <table class="nutrition-table">
        <caption>營養素總量估算</caption>
        <tbody>
          <tr class="nutrition-head">
            <th>營養素</th>
            <th>整份總量</th>
          </tr>
          ${rows
            .map(
              ([name, value, unit]) => `
                <tr>
                  <th scope="row">${name}</th>
                  <td>${formatNutritionValue(value)} ${unit}</td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
      <p class="nutrition-note">${escapeHtml(nutrition.note)}</p>
      <section class="nutrition-analysis" aria-label="營養分析">
        <div>
          <span class="analysis-label">營養等級</span>
          <strong class="grade-badge grade-${analysis.grade}">${analysis.grade}</strong>
          <span>${escapeHtml(analysis.summary)}</span>
        </div>
        <strong class="analysis-suggestion-title">建議</strong>
        <ul>
          ${analysis.suggestions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
        </ul>
      </section>
    </div>
  `;
}

function estimateNutrition(recipe) {
  const total = {
    weight: 0,
    calories: 0,
    protein: 0,
    fat: 0,
    saturatedFat: 0,
    transFat: 0,
    carbs: 0,
    sugar: 0,
    sodium: 0,
  };

  recipe.ingredients.forEach((line) => {
    const ingredient = estimateIngredientNutrition(line);
    Object.keys(total).forEach((key) => {
      total[key] += ingredient[key] || 0;
    });
  });

  if (total.weight < 80) {
    total.weight = Math.max(240, recipe.ingredients.length * 70);
    total.calories = Math.max(total.calories, 180 + recipe.ingredients.length * 45);
  }

  const scaledTotal = scaleNutritionTotal(total, 1);
  const per100g = scaleNutrition(scaledTotal, 100 / Math.max(scaledTotal.weight, 1));
  return {
    total: scaledTotal,
    per100g,
    note: "依目前材料文字估算整份料理總量，實際數值會因品牌、用量與烹調方式不同而變動。",
  };
}

function analyzeNutrition(nutrition) {
  const per100g = nutrition.per100g;
  const total = nutrition.total;
  let score = 86;
  const suggestions = [];

  if (per100g.sodium >= 700) {
    score -= 18;
    suggestions.push("鈉含量偏高，可減少醬油、鹽或高鈉調味料，並搭配大量蔬菜。");
  } else if (per100g.sodium >= 400) {
    score -= 8;
    suggestions.push("鈉含量中等偏高，調味料建議分次加入、邊試味道邊調整。");
  }

  if (per100g.saturatedFat >= 6) {
    score -= 14;
    suggestions.push("飽和脂肪偏高，可改用較瘦的肉、減少奶油或油脂用量。");
  } else if (per100g.fat >= 12) {
    score -= 7;
    suggestions.push("脂肪量較高，烹調時可瀝掉多餘油脂或減少煎炸。");
  }

  if (per100g.sugar >= 12) {
    score -= 10;
    suggestions.push("糖量偏高，可先減少糖、味醂或甜醬，最後再微調甜度。");
  }

  if (per100g.calories >= 240) {
    score -= 8;
    suggestions.push("熱量密度較高，建議搭配清爽湯品或燙青菜平衡一餐。");
  }

  if (total.protein >= 25) {
    score += 6;
    suggestions.push("蛋白質含量不錯，適合作為正餐主菜。");
  }

  if (!suggestions.length) {
    suggestions.push("營養分布相對均衡，搭配蔬菜與主食即可。");
  }

  const grade = score >= 82 ? "A" : score >= 68 ? "B" : score >= 52 ? "C" : "D";
  const summary = {
    A: "整體均衡",
    B: "適合日常食用",
    C: "部分營養素需留意",
    D: "建議調整食材或調味",
  }[grade];

  return { grade, summary, suggestions: suggestions.slice(0, 4) };
}

function estimateIngredientNutrition(line = "") {
  const text = String(line || "");
  const weight = ingredientWeightGrams(text);
  const profile = nutritionProfileFor(text);
  return {
    weight,
    calories: (profile.calories * weight) / 100,
    protein: (profile.protein * weight) / 100,
    fat: (profile.fat * weight) / 100,
    saturatedFat: (profile.saturatedFat * weight) / 100,
    transFat: 0,
    carbs: (profile.carbs * weight) / 100,
    sugar: (profile.sugar * weight) / 100,
    sodium: (profile.sodium * weight) / 100,
  };
}

function ingredientWeightGrams(text) {
  const multiplier = quantityMultiplier(text);
  const grams = text.match(/(\d+(?:\.\d+)?)\s*(?:公克|克|g)/i);
  if (grams) return Number(grams[1]) * multiplier;
  const kg = text.match(/(\d+(?:\.\d+)?)\s*(?:公斤|kg)/i);
  if (kg) return Number(kg[1]) * 1000 * multiplier;
  const ml = text.match(/(\d+(?:\.\d+)?)\s*(?:毫升|ml|cc)/i);
  if (ml) return Number(ml[1]) * multiplier;
  const tbsp = text.match(/(\d+(?:\.\d+)?)\s*大匙/);
  if (tbsp) return Number(tbsp[1]) * 15 * multiplier;
  const tsp = text.match(/(\d+(?:\.\d+)?)\s*(?:小匙|茶匙)/);
  if (tsp) return Number(tsp[1]) * 5 * multiplier;
  const cup = text.match(/(\d+(?:\.\d+)?)\s*杯/);
  if (cup) return Number(cup[1]) * 200 * multiplier;
  const pieces = text.match(/(\d+(?:\.\d+)?)\s*(?:顆|個|片|根|支|瓣|朵|把|包)/);
  if (pieces) return Number(pieces[1]) * defaultUnitWeight(text) * multiplier;
  if (/少許/.test(text)) return 3;
  if (/適量/.test(text)) return defaultUnitWeight(text);
  return defaultUnitWeight(text);
}

function quantityMultiplier(text) {
  if (!/各\s*\d|各\s*[一二三四五六七八九十半]/.test(text)) return 1;
  const beforeEach = text.split(/各\s*(?:\d|[一二三四五六七八九十半])/)[0] || text;
  const names = beforeEach
    .replace(/[（(].*?[)）]/g, "")
    .split(/[、，,・／/+]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return Math.max(1, Math.min(names.length, 4));
}

function defaultUnitWeight(text) {
  if (/醬油|味噌|魚露|鹽|糖|砂糖|味醂|米酒|料理酒|油/.test(text)) return 12;
  if (/蒜|薑|辣椒|蔥/.test(text)) return 8;
  if (/蛋/.test(text)) return 55;
  if (/肉|牛|豬|雞|魚|蝦/.test(text)) return 120;
  if (/麵|飯|米|馬鈴薯|地瓜|粉/.test(text)) return 120;
  if (/奶油|起司|乳酪|鮮奶油/.test(text)) return 25;
  return 60;
}

function nutritionProfileFor(text) {
  const profiles = [
    [/醬油|魚露/, { calories: 53, protein: 8, fat: 0, saturatedFat: 0, carbs: 5, sugar: 1, sodium: 5600 }],
    [/鹽/, { calories: 0, protein: 0, fat: 0, saturatedFat: 0, carbs: 0, sugar: 0, sodium: 39000 }],
    [/砂糖|糖|蜂蜜|味醂/, { calories: 380, protein: 0, fat: 0, saturatedFat: 0, carbs: 95, sugar: 90, sodium: 5 }],
    [/油|橄欖油|沙拉油|麻油/, { calories: 884, protein: 0, fat: 100, saturatedFat: 14, carbs: 0, sugar: 0, sodium: 0 }],
    [/牛|牛肉/, { calories: 250, protein: 26, fat: 15, saturatedFat: 6, carbs: 0, sugar: 0, sodium: 72 }],
    [/豬|豬肉/, { calories: 270, protein: 25, fat: 18, saturatedFat: 6, carbs: 0, sugar: 0, sodium: 62 }],
    [/雞|雞肉/, { calories: 190, protein: 27, fat: 8, saturatedFat: 2.3, carbs: 0, sugar: 0, sodium: 74 }],
    [/魚|蝦|海鮮/, { calories: 120, protein: 22, fat: 3, saturatedFat: 0.8, carbs: 0, sugar: 0, sodium: 120 }],
    [/蛋/, { calories: 155, protein: 13, fat: 11, saturatedFat: 3.3, carbs: 1.1, sugar: 1.1, sodium: 124 }],
    [/麵|飯|米|粉|馬鈴薯|地瓜/, { calories: 130, protein: 2.7, fat: 0.3, saturatedFat: 0.1, carbs: 28, sugar: 0.2, sodium: 2 }],
    [/奶油|起司|乳酪|鮮奶油|cheese|butter/, { calories: 360, protein: 8, fat: 32, saturatedFat: 20, carbs: 4, sugar: 3, sodium: 650 }],
    [/豆腐|豆|豆皮/, { calories: 90, protein: 8, fat: 5, saturatedFat: 0.8, carbs: 2, sugar: 0.7, sodium: 12 }],
    [/番茄|洋蔥|青菜|蘿蔔|菇|蔥|蒜|薑|菜|高麗菜|紅蘿蔔/, { calories: 35, protein: 1.2, fat: 0.2, saturatedFat: 0, carbs: 7, sugar: 3, sodium: 20 }],
  ];
  const matched = profiles.find(([pattern]) => pattern.test(text));
  return matched?.[1] || { calories: 90, protein: 2, fat: 2, saturatedFat: 0.5, carbs: 15, sugar: 2, sodium: 40 };
}

function divideNutrition(total, divisor) {
  return scaleNutrition(total, 1 / Math.max(divisor, 1));
}

function scaleNutrition(total, ratio) {
  return {
    calories: total.calories * ratio,
    protein: total.protein * ratio,
    fat: total.fat * ratio,
    saturatedFat: total.saturatedFat * ratio,
    transFat: total.transFat * ratio,
    carbs: total.carbs * ratio,
    sugar: total.sugar * ratio,
    sodium: total.sodium * ratio,
  };
}

function scaleNutritionTotal(total, ratio) {
  return {
    weight: total.weight * ratio,
    ...scaleNutrition(total, ratio),
  };
}

function formatNutritionValue(value) {
  const number = Number(value || 0);
  if (number >= 100) return String(Math.round(number));
  if (number >= 10) return String(Math.round(number * 10) / 10);
  return String(Math.round(number * 10) / 10);
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
      label: `來源檔：${crawl.sourceFile || "來源清單"}`,
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
    ? "正在依來源清單更新內容"
    : `來源清單已整理 ${crawl.itemCount || 0} 筆食譜`;
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
  resetDefaultFilters();
  const ticker = startCrawlTicker();
  try {
    const response = await fetch("/api/content/update", { method: "POST" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "內容更新啟動失敗");
    renderCrawlPanel(payload.crawl);
    showToast("內容更新已開始，系統會依來源清單擷取。");
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
  resetDefaultFilters();
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
    const hadSearch = Boolean(state.lastQuery || elements.queryInput.value.trim());
    resetDefaultFilters();
    if (hadSearch) loadInitialRecipes();
    else applyFilters();
  });

  ["change", "input"].forEach((eventName) => {
    [elements.typeSelect, elements.cuisineSelect, elements.favoriteOnly, elements.structuredOnly, elements.sortSelect].filter(Boolean).forEach((control) =>
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

  elements.prevPage?.addEventListener("click", () => goToPage(state.currentPage - 1));
  elements.nextPage?.addEventListener("click", () => goToPage(state.currentPage + 1));

  elements.saveButton.addEventListener("click", () => toggleFavorite());
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

  elements.importToggle?.addEventListener("click", () => {
    const hidden = !elements.importPanel.hidden;
    elements.importPanel.hidden = hidden;
    elements.importToggle.setAttribute("aria-expanded", String(!hidden));
    if (!hidden) fetchCrawlStatus();
  });
  elements.bulkButton?.addEventListener("click", runContentUpdateNow);
  elements.refreshCrawlStatus?.addEventListener("click", fetchCrawlStatus);

  $("#helpButton").addEventListener("click", () => {
    showToast("更新食譜來源後，按內容更新即可重新擷取。");
  });
}

configureCuisineOptions();
removeSourceSections();
bindEvents();

function resetDefaultFilters() {
  state.lastQuery = "";
  if (elements.queryInput) elements.queryInput.value = "";
  $$('input[name="time"]').forEach((input) => {
    input.checked = false;
  });
  if (elements.typeSelect) elements.typeSelect.value = "全部";
  if (elements.cuisineSelect) elements.cuisineSelect.value = "全部";
  $$("#categoryChips .chip").forEach((button) => button.classList.toggle("active", button.dataset.value === "全部"));
  $$("#difficultyControl button").forEach((button) => button.classList.toggle("active", button.dataset.value === "全部"));
  state.activeCategory = "全部";
  state.activeDifficulty = "全部";
}

async function init() {
  resetDefaultFilters();
  await loadUserState();
  await fetchCrawlStatus();
  await loadInitialRecipes();
}

init().catch((error) => showToast(error.message || "初始資料載入失敗"));
