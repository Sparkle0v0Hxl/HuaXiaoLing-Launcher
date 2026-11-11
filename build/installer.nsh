; ---------------------------------------------------------------
; HuaXiaoLing Launcher - custom NSIS installer appearance
;
; electron-builder includes this file in the common script header,
; before installer.nsi, so every !define here applies to all MUI
; pages that follow.
;
; Appearance and wording only. Not a single line of install logic is
; touched: where it installs, which registry keys it writes and how
; app.asar gets unpacked all stay with the electron-builder template.
;
; Bitmaps and icons live next to this file and are picked up by name:
;   installerSidebar.bmp   164x314  welcome / finish page (left)
;   installerHeader.bmp    150x57   every page header strip
;   installerIcon.ico / uninstallerIcon.ico
;
; NOTE: keep this file ASCII-only. makensis reads !include'd files in
; the system code page unless they carry a UTF-8 BOM, and a stray BOM
; rewrite turns every Chinese comment into "Bad text encoding".
; ---------------------------------------------------------------

!ifndef HXL_INSTALLER_NSH
!define HXL_INSTALLER_NSH

; Confirm before aborting an install (default is silent cancel).
!define MUI_ABORTWARNING

; Chinese titles are long; allow three lines instead of two.
!define MUI_WELCOMEPAGE_TITLE_3LINES
!define MUI_FINISHPAGE_TITLE_3LINES

; -- framework colours --------------------------------------------
; MUI draws every page on these two colours (MUI_BGCOLOR /
; MUI_TEXTCOLOR default to plain white / black). Switching them is
; what actually changes the look of the whole wizard; the sidebar
; bitmap alone only tints the left column.
;
; BRAND_BG    dark plum   = the sidebar's base colour, so the bitmap
;                           edge merges into the page instead of
;                           ending on a white seam.
; BRAND_TEXT  cream       = same cream as the launcher UI.
; BRAND_SUB   muted mauve = secondary text on the header strip.
;
; Colours are "RRGGBB" without the leading '#'. SetCtlColors only
; understands plain colours here - no gradients, no alpha.
!define BRAND_BG   "1B1020"
!define BRAND_TEXT "F7EAD8"
!define BRAND_SUB  "D6B4D2"

!define MUI_BGCOLOR   "${BRAND_BG}"
!define MUI_TEXTCOLOR "${BRAND_TEXT}"

; Directory page: keep the "choose a folder" text readable on the
; dark background (empty means "inherit MUI_TEXTCOLOR", which is not
; supported by every NSIS build, so state it).
!define MUI_DIRECTORYPAGE_TEXTCOLOR "${BRAND_TEXT}"
!define MUI_STARTMENUPAGE_TEXTCOLOR "${BRAND_TEXT}"

; Install-progress page: "/windows" is a system-coloured rectangle.
; "0x${BRAND_BG} 0x${BRAND_TEXT}" asks for a themed bar instead.
!define MUI_INSTFILESPAGE_COLORS "0x${BRAND_BG} 0x${BRAND_TEXT}"
!define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"

; -- welcome page -------------------------------------------------
; Replaces the default grey paragraph. Says what the app is, that it
; is unsigned, and where to put the antivirus exclusion.
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "欢迎安装 花筱灵启动器"
  !define MUI_WELCOMEPAGE_TEXT "$\r$\n这是一个多游戏启动器：原神、星穹铁道、绝区零、崩坏3、明日方舟、异环、终末地，统一在一个界面里管。$\r$\n$\r$\n支持渠道切换（官服 / B服 / 国际服等）、硬链接去重省空间、增量更新与预下载。$\r$\n$\r$\n点「下一步」可以选安装位置，装在哪个盘都行，建议非系统盘。$\r$\n$\r$\n$\r$\n提示：程序没有代码签名，部分杀毒软件可能拦截。$\r$\n安装完成后，请把安装目录整个（重点是 resources 子目录）加进杀毒软件的排除项。"
  !insertmacro MUI_PAGE_WELCOME
!macroend

; -- finish page --------------------------------------------------
; Keeps electron-builder's "run now" checkbox (it launches via
; $launchLink) and only swaps the title and body text.
!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function hxlFinishStartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "hxlFinishStartApp"
  !endif

  !define MUI_FINISHPAGE_TITLE "花筱灵启动器 安装完成"
  !define MUI_FINISHPAGE_TEXT "$\r$\n安装完成了。$\r$\n$\r$\n第一次打开如果被杀毒软件拦下，把安装目录整个加进排除项再运行。$\r$\n游戏本体和渠道包都在各自的目录里，卸载启动器不会动它们。$\r$\n$\r$\n祝玩得开心。"
  !define MUI_FINISHPAGE_NOREBOOTSUPPORT
  !insertmacro MUI_PAGE_FINISH
!macroend

; -- uninstaller welcome page -------------------------------------
; The most misunderstood part of uninstalling: does it eat my games?
; Answer it up front.
!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "卸载 花筱灵启动器"
  !define MUI_WELCOMEPAGE_TEXT "$\r$\n将从本机移除 花筱灵启动器。$\r$\n$\r$\n不会被删除的：$\r$\n  · 你的游戏本体和渠道包$\r$\n  · data 目录里的游戏列表、设置、歌单和抽卡记录$\r$\n$\r$\n点「下一步」开始卸载。"
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

!endif ; HXL_INSTALLER_NSH
