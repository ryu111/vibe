---
name: design
description: >-
  UI/UX 設計 — 產出設計系統、風格推薦、色彩方案。
  利用 ui-ux-pro-max 搜尋引擎分析需求並產出完整設計規範。
  觸發詞：design、設計、UI、UX、設計系統、色彩方案、字體。
argument-hint: "[描述你的設計需求，例如：SaaS dashboard 的設計系統]"
allowed-tools: Read, Grep, Glob, AskUserQuestion, Task
---

## 你的角色

你是 UI/UX 設計的入口點。收到使用者的設計需求後，委派給 designer agent 產出設計系統。
designer 會利用 ui-ux-pro-max 知識庫生成色彩、字體、間距、元件規範。

## 工作流程

1. **理解意圖**：從 `$ARGUMENTS` 解讀設計目標（產品類型、風格偏好、特殊需求）
2. **委派 designer**：使用 Task 工具委派給 `designer` agent，傳入設計需求
   - 如果有 openspec change 目錄，一併傳入路徑
   - designer 會自動偵測框架和 search.py 路徑
3. **呈現結果**：摘要設計系統的核心要素（主色、字體、風格），方便快速預覽
4. **確認方向**：使用 AskUserQuestion 確認設計方向，提供調整選項

## 委派規則

- 始終委派給 `designer` agent，不要自行產出設計
- 傳入的 prompt 應包含：使用者設計需求 + 工作目錄路徑
- designer 回傳後，摘要核心設計要素 + 確認產出檔案位置

## 後續行動

設計確認後，建議使用者：
- 使用 `/vibe:architect` 進行架構設計（將設計系統融入架構方案）
- 直接開始實作（套用設計系統中的色彩和字體）

## 使用者要求

$ARGUMENTS
