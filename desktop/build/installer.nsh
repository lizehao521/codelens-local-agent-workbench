; CodeLens 安装器自定义脚本（electron-builder nsis.include）
;
; 背景：electron-builder 内置的卸载流程用注册表里的 ShortcutName 推导快捷方式
; 路径再删除。实测在「装过旧版 → 覆盖安装 → 卸载」这条链路上，桌面快捷方式
; 会被漏删，留下一个指向已删除 CodeLens.exe 的死图标（开始菜单项能正常删除）。
; 这里在卸载收尾时按已知名称兜底删除，幂等且不影响其它逻辑。

!macro customUnInstall
  ; 桌面快捷方式：当前名 + 历史包名两种可能
  !ifdef SHORTCUT_NAME
    Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  !endif
  Delete "$DESKTOP\CodeLens.lnk"
  Delete "$DESKTOP\codelens-desktop.lnk"

  ; 开始菜单快捷方式与目录
  !ifdef SHORTCUT_NAME
    Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
  !endif
  Delete "$SMPROGRAMS\CodeLens.lnk"
  RMDir "$SMPROGRAMS\CodeLens"

  ; 刷新桌面/资源管理器图标缓存（与内置逻辑一致）
  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'
!macroend
