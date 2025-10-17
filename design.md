# 微信小程序版 Idasen 桌子控制器设计文档

## 1. 背景与目标
- 将现有 macOS 菜单栏应用的核心能力迁移到微信小程序中，实现通过手机对 Idasen 升降桌的连接、读取高度、发送动作指令等功能。
- 利用微信小程序 BLE 能力，完成扫描、连接、订阅高度变化、发送控制指令等流程。
- 在仓库中新建 `wechat-miniapp/` 子目录，保持现有 macOS 工程不受影响。

## 2. 现有 macOS 工程参考
- **蓝牙管理**（`Desk Controller/BluetoothManager.swift`、`Desk Controller/Desk control/DeskPeripheral.swift`、`Desk Controller/Desk control/DeskController.swift`）：扫描名称包含 “Desk” 的设备，连接 LINAK GATT 服务，读取高度（`99FA0020…/0021`），发送动作指令（`0x4700` 上升、`0x4600` 下降、`0xFF00` 停止）。
- **预设与偏好**（`Desk Controller/Preferences/*`）：保存用户定义的坐/站高度与单位。
- **界面**（`ViewController.swift`、`TouchButton.swift` 等）：展示当前高度、快捷动作、预设与自动站立。

微信小程序需复用这些关键能力：连接管理、实时高度显示、预设管理与手动控制。

## 3. 需求

### 功能需求
- 扫描并连接名称包含 `Desk` 的蓝牙设备。
- 订阅 `99FA0021-338A-1024-8A49-009C0215F78A` 特征，实时显示桌子高度。
- 通过 `99FA0002-338A-1024-8A49-009C0215F78A` 特征发送动作（上升、下降、停止）。
- 支持手动短按上下移动与立即停止操作。
- 支持至少坐/站两个高度预设，允许编辑自定义高度与输入目标高度。
- 本地持久化预设与单位设置（使用微信存储接口）。
- 显示连接状态、高度、移动状态。

### 非功能需求
- 在 iOS 与 Android 微信客户端均应具备良好体验。
- 妥善处理 BLE 权限、适配器关闭、断连等场景。
- 模块化代码，为后续自动化扩展留接口。
- 关键文档中文或中英双语，便于后续维护。

## 4. 小程序整体架构

```
wechat-miniapp/
  app.json
  app.ts
  app.wxss
  project.config.json
  sitemap.json
  /pages
    /connection
      index.ts
      index.wxml
      index.wxss
      index.json
    /control
      index.ts
      index.wxml
      index.wxss
      index.json
    /settings
      index.ts
      index.wxml
      index.wxss
      index.json
  /utils
      ble.ts
      desk-protocol.ts
      storage.ts
      format.ts
  /types
      index.d.ts
  /assets
      图标与插图
  /docs
      README.md
```

- 采用 TypeScript，并可引入 `miniprogram-api-typings` 提升开发体验。
- `utils/ble.ts`：封装微信 BLE 接口，负责适配器初始化、扫描、连接、特征管理、通知监听、清理等。
- `utils/desk-protocol.ts`：定义服务/特征 UUID，提供高度解析、命令编码、容差/停止逻辑。
- `pages/connection`：蓝牙连接管理，负责扫描、展示附近设备与连接状态。
- `pages/control`：主控制面板（实时高度、手动控制、坐/站预设）。
- `pages/settings`：单位切换、预设高度调整、自动重连设置。
- `utils/storage.ts`：封装微信本地存储读写。

## 5. BLE 通信设计

| 操作 | 微信接口 | 说明 |
| --- | --- | --- |
| 初始化适配器 | `wx.openBluetoothAdapter` | 申请蓝牙权限，失败时提示用户开启蓝牙与定位 |
| 扫描设备 | `wx.startBluetoothDevicesDiscovery` | 客户端过滤 `device.name.includes('Desk')`，展示候选设备 |
| 建立连接 | `wx.createBLEConnection` | 保存 `deviceId` 用于后续操作 |
| 发现服务 | `wx.getBLEDeviceServices` | 定位位置服务 `99FA0020…` 与控制服务 `99FA0001…` |
| 发现特征 | `wx.getBLEDeviceCharacteristics` | 存储位置特征与控制特征句柄 |
| 订阅通知 | `wx.notifyBLECharacteristicValueChange` | 处理 ArrayBuffer，按小端解析高度并加上偏移 61.5 |
| 写指令 | `wx.writeBLECharacteristicValue` | 上升 `47 00`，下降 `46 00`，停止 `FF 00`；移动到指定高度依赖通知闭环 |
| 资源清理 | `wx.closeBLEConnection`、`wx.closeBluetoothAdapter` | 页面卸载或断开连接时调用 |

**高度换算**：`高度(cm) = UInt16(position_bytes) / 100 + 61.5`。速度值可用于判断是否仍在移动。

**移动到指定高度策略**：
1. 计算目标与当前位置差值决定方向；
2. 发送上升/下降指令；
3. 监听位置通知，根据容差（0.5cm）与速度判断是否到位；
4. 超时或过冲时发送停止指令，确保安全。

## 6. UI/UX 设计
- **首页（Index）**
  - 连接卡片：状态指示、连接/断开按钮、设备列表弹窗。
  - 高度显示：大号数字，支持单位切换。
  - 动作按钮：上升、下降、停止；仅在已连接时启用。
  - 快捷预设：坐、站、自定义按钮。
  - 可选：折叠的动作日志或状态提示。
- **预设页（Presets）**
  - 列表展示所有预设，支持编辑/删除。
  - 新增预设：从当前高度获取或手动输入。
  - 每个预设提供“移动到该高度”操作。
- **设置页（Settings）**
  - 单位切换（cm/in）。
  - 自动重连上次设备开关。
  - 调试信息（设备 UUID、通知状态等）。

## 7. 数据与状态管理
- 在 `app.ts` 中维护全局状态（连接信息、当前高度、预设列表），通过 `getApp()` 或事件总线在各页面共享。
- 使用 `wx.setStorage` / `wx.getStorage` 持久化预设与单位偏好。
- `ble.ts` 作为单例，避免不同页面同时操作蓝牙产生冲突。

## 8. 异常处理与边界情况
- 适配器关闭或权限拒绝：弹出提示，引导用户开启蓝牙/定位。
- 设备被其他客户端占用：提示用户断开其他连接。
- 订阅通知失败：允许用户重试或重新连接。
- 连接断开：自动尝试重连（可配置），并更新 UI 状态。
- 高度数据异常：忽略非法数据，显示 `--` 或提示无效读数。

## 9. 实施计划
1. **仓库准备**
   - 新建 `wechat-miniapp/` 基础目录与配置文件，编写 README。
   - 添加 `tsconfig.json`、可选 `package.json`（用于类型定义和脚本）。
2. **工具层开发**
   - `ble.ts`：封装初始化、扫描、连接、通知、关闭。
   - `desk-protocol.ts`：封装 UUID、命令常量、高度解析与容差逻辑。
   - `storage.ts`：封装预设与偏好存取。
   - `format.ts`：高度/单位格式化工具。
3. **全局应用初始化**
   - 在 `app.ts` 中加载本地数据，初始化事件通道，应用退出时清理连接。
4. **首页页面实现**
   - 布局连接状态、设备列表、当前高度、动作按钮、快捷预设。
   - 绑定 BLE 事件更新界面，处理按钮交互。
5. **预设页面实现**
   - 预设 CRUD，支持从当前高度或手动输入设置新预设。
   - 支持长按/滑动删除，提供移动到预设高度功能。
6. **设置页面实现**
   - 单位切换、自动重连、调试信息展示。
7. **测试与验证**
   - 使用微信开发者工具模拟基本流程。
   - 真机连接 Idasen 桌测试：连接稳定性、移动准确性、断开重连等。
   - 调整容差/超时参数，确保到位停止及时。
8. **文档补充**
   - 在 `wechat-miniapp/docs/README.md` 记录构建、调试步骤与注意事项。
   - 撰写 macOS 应用与小程序能力对照表。

## 10. 风险与缓解措施
- **微信 BLE 限制**：Android 需定位权限且蓝牙常开。→ 检测失败场景，提供引导文案。
- **指令延迟导致过冲**：需要精确的停止逻辑。→ 结合速度值和容差判断，超时强制发送停止指令。
- **小程序后台挂起**：可能导致操作中断。→ 在文档与 UI 中提示用户保持小程序前台。
- **多机型差异**：不同手机 BLE 行为差异明显。→ 在 iOS/Android 均进行真机测试，记录已知问题。

## 11. 待确认问题
- 是否需要支持多台桌子（设备列表）并保存选择历史？
- 是否需要提供类似 AppleScript 的外部触发接口或与其他自动化工具对接？
- UI 品牌视觉是否有特定要求或需要遵循现有风格？

确认上述方案后，将按照实施计划逐步创建 `wechat-miniapp/` 目录并开始编码。
