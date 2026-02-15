# OpenSpec Schema Delta Spec

## ADDED Requirements

### Requirement: design-system Artifact

openspec/schemas/vibe-pipeline/schema.yaml 新增 design-system artifact 定義，標記其在 pipeline artifact 依賴圖中的位置。

#### Scenario: design-system artifact 定義

WHEN 讀取 schema.yaml 的 artifacts
THEN 存在 id === 'design-system' 的 artifact
AND generates === 'design-system.md'
AND requires 包含 'proposal' 和 'design'

#### Scenario: design-mockup artifact 定義

WHEN 讀取 schema.yaml 的 artifacts
THEN 存在 id === 'design-mockup' 的 artifact
AND generates === 'design-mockup.html'
AND requires 包含 'design-system'

## MODIFIED Requirements

### Requirement: Schema 描述更新

schema.yaml 的 description 從 '8-stage pipeline' 更新為 '9-stage pipeline'。

完整更新：

```yaml
name: vibe-pipeline
version: 2
description: Vibe 9-stage pipeline 相容的 SDD schema
```

### Requirement: apply.requires 保持不變

apply 區段的 requires 仍為 `[tasks]`，不依賴 design-system（design-system 是可選產出）。
