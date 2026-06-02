# 食譜快找

正式版 Node.js 食譜整理網站。資料來源改為 `recipe-urls.md`：你把食譜網址貼進 Markdown 檔，網站只有在你按「內容更新」時才會依照清單擷取內容。

## 功能

- 不需要 API Key。
- 不會每天自動上網爬文。
- 讀取 `recipe-urls.md` 裡的公開食譜網址。
- 如果貼的是食譜入口頁或分類頁，會自動尋找同站的單篇食譜連結。
- 按「內容更新」後才擷取網址內容並更新索引。
- 搜尋框只搜尋已更新的索引資料。
- 支援收藏、筆記、份量換算、來源連結與列印。

## 本機啟動

```powershell
cd outputs\recipe-crawler-web
npm.cmd start
```

網站網址：

```text
http://127.0.0.1:4173/
```

檢查語法：

```powershell
npm.cmd run check
```

## 如何新增來源

打開 [recipe-urls.md](recipe-urls.md)，把食譜網址貼到「我的來源」下面：

```md
## 我的來源

- https://example.com/recipe-1
- https://example.com/recipe-2
```

回到網頁按「內容更新」，系統會依照 MD 檔裡的網址重新擷取。

## 設定

可用 `.env.local` 調整：

```env
CONTENT_SOURCE_FILE=recipe-urls.md
CONTENT_SOURCE_URL_LIMIT=80
CONTENT_DISCOVERY_LIMIT_PER_SOURCE=6
CONTENT_MAX_ITEMS=80
```

## 雲端部署

請看 [docs/deployment.md](docs/deployment.md)。部署到雲端後，更新 `recipe-urls.md` 並重新部署，或把 `CONTENT_SOURCE_FILE` 指向雲端持久化磁碟中的 Markdown 檔。
