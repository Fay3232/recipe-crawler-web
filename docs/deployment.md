# 部署指南

這個版本不需要 Google、Brave 或 Spoonacular API Key。網站只讀取 Markdown 檔裡的食譜網址，並在你按「內容更新」時擷取內容。

## 1. 網址清單

預設來源檔：

```text
recipe-urls.md
```

把食譜網址貼到檔案中的「我的來源」區塊：

```md
## 我的來源

- https://example.com/recipe-1
- https://example.com/recipe-2
```

程式會忽略 Markdown 程式碼區塊中的示範網址，只擷取一般文字或清單裡的 `http` / `https` 網址。

## 2. Render 部署

1. 把 `outputs/recipe-crawler-web` 放到 GitHub repository。
2. 到 Render 建立 Blueprint，選擇 repository 內的 `render.yaml`。
3. Render 會建立 Docker web service，並掛載 `/app/data` 持久化磁碟保存更新後的索引。
4. 不需要設定任何 API Key Secret。

Render 部署完成後會自動產生：

```text
https://你的服務名稱.onrender.com
```

## 3. 雲端更新方式

最簡單方式：

1. 在 GitHub 修改 `recipe-urls.md`。
2. 等 Render 自動部署完成。
3. 到網站按「內容更新」。

如果你想在伺服器上直接維護 MD 檔，可以把環境變數改成：

```env
CONTENT_SOURCE_FILE=/app/data/recipe-urls.md
```

這樣 Markdown 檔會放在 Render 持久化磁碟中，但你需要用 Render Shell 或其他後台方式修改該檔案。

## 4. API

內容狀態：

```text
GET /api/content/status
```

手動更新內容：

```text
POST /api/content/update
```

舊路徑 `/api/crawl/status` 和 `/api/crawl/run` 仍保留為相容別名。

## 5. 注意事項

- 不需要 API Key。
- 不會自動每天上網抓資料。
- 按「內容更新」才會依 `recipe-urls.md` 擷取。
- 有些網站可能封鎖伺服器抓取或沒有結構化食譜資料，這種來源可能只會取得部分內容或失敗。
