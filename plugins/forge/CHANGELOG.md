# Changelog

## 0.1.3 (2026-02-14)

- 新增 `/forge:skill` 漸進式揭露規則（D-1 ~ D-6）
- Skill spec 加入 ECC 三層載入機制說明

## 0.1.2 (2026-02-14)

- 驗證腳本重大升級：
  - V-AG-19：Agent 色彩驗證（8 合法值）
  - V-HK-18/19：matcher 型別 + flat 格式警告
  - `validate-script.sh` 支援 .sh + .js 雙語言
  - `validate-hook.sh` 支援 flat + grouped 兩種格式
- Pipeline 驗證規則（P-10 ~ P-15）

## 0.1.1 (2026-02-13)

- 加入版號更新規則
- `plugin.json` 嚴格驗證（未知欄位檢查 P-04b）
- Reference specs 同步實際行為

## 0.1.0 (2026-02-13)

- 初始版本
- 4 個核心 skill：scaffold、skill、agent、hook
- 5 份規格書：plugin-spec、skill-spec、agent-spec、hook-spec、script-spec
- 81 條驗證規則（P-01~15 + V-SK-01~18 + V-AG-01~19 + V-HK-01~19 + V-SC-01~10）
- 7 個模板檔案
- PostToolUse 自動驗證流程
