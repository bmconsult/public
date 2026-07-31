# VITALS - a system monitor that measures the machine it runs on and explains what it finds.
# Copyright 2026 Ben M
# SPDX-License-Identifier: Apache-2.0
# probe-ctl.ps1 — capability probe for the CTRL surface (2026-07-29).
# READ-ONLY except for same-value writes (write X where X = current value), which prove ACL
# access without changing anything. Emits one JSON object. Run unelevated — that is the point.
$ErrorActionPreference='SilentlyContinue'
$r=@{}

# --- power plans: list + active (powercfg /l works unelevated; /setactive tested same-value) ---
$pl=powercfg /l 2>$null
$r.powerPlans=@($pl | Select-String 'GUID: ([0-9a-f-]+)\s+\((.+?)\)(\s*\*)?' | ForEach-Object{
  @{guid=$_.Matches[0].Groups[1].Value;name=$_.Matches[0].Groups[2].Value;active=[bool]$_.Matches[0].Groups[3].Value.Trim()}})
$act=($r.powerPlans | Where-Object{$_.active}).guid
powercfg /setactive $act 2>$null
$r.powerSetActiveOk=($LASTEXITCODE -eq 0)

# --- display modes (read) ---
Add-Type -Name D -Namespace W -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumDisplaySettings(string dev,int mode,ref DEVMODE dm);
[DllImport("user32.dll")] public static extern int ChangeDisplaySettings(ref DEVMODE dm,int flags);
[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Ansi)]
public struct DEVMODE{ [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string dmDeviceName;
 public short dmSpecVersion,dmDriverVersion,dmSize,dmDriverExtra; public int dmFields;
 public int dmPositionX,dmPositionY,dmDisplayOrientation,dmDisplayFixedOutput;
 public short dmColor,dmDuplex,dmYResolution,dmTTOption,dmCollate;
 [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string dmFormName;
 public short dmLogPixels; public int dmBitsPerPel,dmPelsWidth,dmPelsHeight,dmDisplayFlags,dmDisplayFrequency;
 public int dmICMMethod,dmICMIntent,dmMediaType,dmDitherType,dmReserved1,dmReserved2,dmPanningWidth,dmPanningHeight; }
'@
$dm=New-Object W.D+DEVMODE; $dm.dmSize=[int16][System.Runtime.InteropServices.Marshal]::SizeOf($dm)
[W.D]::EnumDisplaySettings($null,-1,[ref]$dm) | Out-Null   # -1 = current
$r.display=@{w=$dm.dmPelsWidth;h=$dm.dmPelsHeight;hz=$dm.dmDisplayFrequency;bpp=$dm.dmBitsPerPel}
$rates=New-Object System.Collections.Generic.HashSet[int]
$i=0; $d2=New-Object W.D+DEVMODE; $d2.dmSize=$dm.dmSize
while([W.D]::EnumDisplaySettings($null,$i,[ref]$d2)){ if($d2.dmPelsWidth -eq $dm.dmPelsWidth -and $d2.dmPelsHeight -eq $dm.dmPelsHeight){ [void]$rates.Add($d2.dmDisplayFrequency) }; $i++ }
$r.refreshRates=@($rates)|Sort-Object
# same-mode CDS test (CDS_TEST=2): proves the call path without changing anything
$r.displayTest=[W.D]::ChangeDisplaySettings([ref]$dm,2)   # 0 = DISP_CHANGE_SUCCESSFUL

# --- shell personalization (HKCU) ---
$pz='HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize'
$r.appsLight=(Get-ItemProperty $pz).AppsUseLightTheme
$r.sysLight=(Get-ItemProperty $pz).SystemUsesLightTheme
$r.transparency=(Get-ItemProperty $pz).EnableTransparency
try{ Set-ItemProperty $pz AppsUseLightTheme ([int]$r.appsLight) -ErrorAction Stop; $r.personalizeWriteOk=$true }catch{ $r.personalizeWriteOk=$false }
$dwm='HKCU:\SOFTWARE\Microsoft\Windows\DWM'
$r.accentColor=(Get-ItemProperty $dwm).AccentColor
$r.colorPrevalence=(Get-ItemProperty $dwm).ColorPrevalence
try{ Set-ItemProperty $dwm AccentColor ([uint32]$r.accentColor) -ErrorAction Stop; $r.dwmWriteOk=$true }catch{ $r.dwmWriteOk=$false }

# --- explorer / taskbar (HKCU) ---
$adv='HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\Advanced'
$a=Get-ItemProperty $adv
$r.taskbarAl=$a.TaskbarAl; $r.hideExt=$a.HideFileExt; $r.showHidden=$a.Hidden
try{ Set-ItemProperty $adv HideFileExt ([int]$a.HideFileExt) -ErrorAction Stop; $r.advWriteOk=$true }catch{ $r.advWriteOk=$false }

# --- pointer (SPI reads + same-value writes) ---
Add-Type -Name U -Namespace W2 -MemberDefinition @'
[DllImport("user32.dll",SetLastError=true)] public static extern bool SystemParametersInfo(uint a,uint b,ref int c,uint f);
[DllImport("user32.dll",SetLastError=true)] public static extern bool SystemParametersInfoPtr(uint a,uint b,IntPtr c,uint f);
'@
$spd=0; [W2.U]::SystemParametersInfo(0x70,0,[ref]$spd,0)|Out-Null   # SPI_GETMOUSESPEED
$r.mouseSpeed=$spd
$r.mouseSpeedWriteOk=[W2.U]::SystemParametersInfoPtr(0x71,0,[IntPtr]$spd,0)  # SPI_SETMOUSESPEED same value
$tr=0; [W2.U]::SystemParametersInfo(0x5E,0,[ref]$tr,0)|Out-Null     # SPI_GETMOUSETRAILS
$r.mouseTrails=$tr

# --- cursors scheme + sound scheme (HKCU reads) ---
$r.cursorScheme=(Get-ItemProperty 'HKCU:\Control Panel\Cursors' -ErrorAction SilentlyContinue).'(default)'
$r.soundScheme=(Get-ItemProperty 'HKCU:\AppEvents\Schemes' -ErrorAction SilentlyContinue).'(default)'

# --- wallpaper (read path; write is SPI 0x14 — not tested, changes visible state) ---
$r.wallpaper=(Get-ItemProperty 'HKCU:\Control Panel\Desktop').WallPaper

# --- visual effects (HKCU VisualFXSetting: 0 auto 1 best-look 2 best-perf 3 custom) ---
$vfx='HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\VisualEffects'
$r.visualFx=(Get-ItemProperty $vfx -ErrorAction SilentlyContinue).VisualFXSetting

# --- things that DO need elevation (probe read-only, record the wall honestly) ---
$r.hagsReadable=$null -ne (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers' -ErrorAction SilentlyContinue).HwSchMode
try{ Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers' HwSchMode ((Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers').HwSchMode) -ErrorAction Stop; $r.hagsWriteOk=$true }catch{ $r.hagsWriteOk=$false }

# --- process priority (own processes, unelevated) ---
try{ $p=Get-Process -Id $PID; $old=$p.PriorityClass; $p.PriorityClass='BelowNormal'; $p.PriorityClass=$old; $r.priorityOk=$true }catch{ $r.priorityOk=$false }

$r | ConvertTo-Json -Depth 5 -Compress
