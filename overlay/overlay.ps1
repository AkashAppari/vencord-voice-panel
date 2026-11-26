<#
  Voice panel desktop overlay.
  Reads the live snapshot that the VoiceChannelPanel Vencord plugin writes into its
  settings file, and draws it in a transparent, always-on-top window.
  No injection, no DirectX hooks: a plain window that repaints only when the state changes.
#>
param(
    [switch]$Headless,   # parse + render to console only, no window (for testing over SSH)
    [switch]$DryRun,     # build the window, then close it immediately
    [int]$PollMs = 400,
    [string]$SnapshotFile = ""   # read a fixed snapshot file instead of Vencord settings (testing)
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms, System.Drawing

$ConfigDir  = Join-Path $env:APPDATA "VoicePanelOverlay"
$ConfigFile = Join-Path $ConfigDir "config.json"
$Script:StaleMs = 8000            # a snapshot older than this means Discord is gone
$Script:DirectSnapshot = [bool]$SnapshotFile

$Script:Defaults = [ordered]@{
    width      = 260
    left       = 40
    top        = 120
    opacity    = 0.82
    showLog    = $true
    clickThrough = $false
    settingsPath = $null
}

function Get-Config {
    $cfg = [ordered]@{}
    foreach ($k in $Script:Defaults.Keys) { $cfg[$k] = $Script:Defaults[$k] }
    if (Test-Path $ConfigFile) {
        try {
            $saved = Get-Content -Raw $ConfigFile | ConvertFrom-Json
            foreach ($p in $saved.PSObject.Properties) { if ($cfg.Contains($p.Name)) { $cfg[$p.Name] = $p.Value } }
        } catch { }
    }
    if (-not $cfg.settingsPath) { $cfg.settingsPath = Find-SettingsFile }
    if ($SnapshotFile) { $cfg.settingsPath = $SnapshotFile }
    $cfg
}

function Save-Config($cfg) {
    if (-not (Test-Path $ConfigDir)) { New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null }
    ($cfg | ConvertTo-Json) | Set-Content -Path $ConfigFile -Encoding UTF8
}

function Find-SettingsFile {
    $candidates = @(
        "C:\Users\$env:USERNAME\Vencord\settings\settings.json",      # source build (VENCORD_USER_DATA_DIR)
        (Join-Path $env:APPDATA "Vencord\settings\settings.json")     # installer build
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    return $null
}

function Get-Snapshot($path) {
    if (-not $path -or -not (Test-Path $path)) { return $null }
    try {
        $raw = Get-Content -Raw -Path $path -ErrorAction Stop
        if (-not $raw) { return $null }
        if ($Script:DirectSnapshot) {
            $snap = $raw | ConvertFrom-Json -ErrorAction Stop
        } else {
            $root = $raw | ConvertFrom-Json -ErrorAction Stop
            $plugin = $root.plugins.voiceChannelPanel
            if (-not $plugin) { return $null }
            $text = $plugin.overlay
            if (-not $text) { return $null }
            $snap = $text | ConvertFrom-Json -ErrorAction Stop
        }
        # Discord can die without the plugin clearing the file, so an old timestamp means "gone".
        if ($snap.t -and -not $Script:DirectSnapshot) {
            $age = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [double]$snap.t
            if ($age -gt $Script:StaleMs) { return $null }
        }
        return $snap
    } catch { return $null }
}

# --- icon geometry (Material Symbols, Apache-2.0) -----------------------------
$Script:IconMic = "M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5.3-3a5.3 5.3 0 0 1-10.6 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-1.7Z"
$Script:IconScreen = "M20 3H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h7v2H8v2h8v-2h-3v-2h7a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Zm0 13H4V5h16v11Z"
$Script:IconCam = "M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4Z"
$Script:IconHeadphones = "M12 1a9 9 0 0 0-9 9v7a3 3 0 0 0 3 3h3v-8H5v-2a7 7 0 1 1 14 0v2h-4v8h3a3 3 0 0 0 3-3v-7a9 9 0 0 0-9-9Z"

function Brush([string]$hex, [double]$alpha = 1.0) {
    $c = [System.Windows.Media.ColorConverter]::ConvertFromString($hex)
    $b = New-Object System.Windows.Media.SolidColorBrush $c
    $b.Opacity = $alpha
    $b
}

function New-Icon([string]$data, [double]$size, $brush, [bool]$slash = $false) {
    $g = New-Object System.Windows.Media.GeometryGroup
    $g.Children.Add(([System.Windows.Media.Geometry]::Parse($data)))
    $path = New-Object System.Windows.Shapes.Path
    $path.Data = $g
    $path.Fill = $brush
    $path.Width = $size
    $path.Height = $size
    $path.Stretch = "Uniform"
    $path.Margin = "0,0,2,0"
    $path.VerticalAlignment = "Center"
    if ($slash) {
        $canvas = New-Object System.Windows.Controls.Canvas
        $canvas.Width = $size
        $canvas.Height = $size
        $canvas.Margin = "0,0,2,0"
        $canvas.VerticalAlignment = "Center"
        $halo = New-Object System.Windows.Shapes.Line
        $halo.X1 = 1.5; $halo.Y1 = 1.5; $halo.X2 = ($size - 1.5); $halo.Y2 = ($size - 1.5)
        $halo.Stroke = $Script:CardBrush
        $halo.StrokeThickness = 4.2
        $halo.StrokeStartLineCap = "Round"; $halo.StrokeEndLineCap = "Round"
        $bar = New-Object System.Windows.Shapes.Line
        $bar.X1 = 1.5; $bar.Y1 = 1.5; $bar.X2 = ($size - 1.5); $bar.Y2 = ($size - 1.5)
        $bar.Stroke = $brush
        $bar.StrokeThickness = 1.8
        $bar.StrokeStartLineCap = "Round"; $bar.StrokeEndLineCap = "Round"
        [void]$canvas.Children.Add($halo)
        [void]$canvas.Children.Add($bar)
        return $canvas
    }
    $path
}

function New-MemberRow($m) {
    $grid = New-Object System.Windows.Controls.Grid
    $grid.Margin = "0,1.5,0,1.5"
    $c1 = New-Object System.Windows.Controls.ColumnDefinition; $c1.Width = "Auto"
    $c2 = New-Object System.Windows.Controls.ColumnDefinition; $c2.Width = "*"
    $c3 = New-Object System.Windows.Controls.ColumnDefinition; $c3.Width = "Auto"
    [void]$grid.ColumnDefinitions.Add($c1); [void]$grid.ColumnDefinitions.Add($c2); [void]$grid.ColumnDefinitions.Add($c3)

    $dot = New-Object System.Windows.Shapes.Ellipse
    $dot.Width = 5; $dot.Height = 5
    $dot.Margin = "0,0,6,0"
    $dot.VerticalAlignment = "Center"
    $dot.Fill = if ($m.speaking) { $Script:SpeakBrush } else { $Script:Transparent }
    [System.Windows.Controls.Grid]::SetColumn($dot, 0)
    [void]$grid.Children.Add($dot)

    $name = New-Object System.Windows.Controls.TextBlock
    $name.Text = [string]$m.name
    $name.FontSize = 12
    $name.TextTrimming = "CharacterEllipsis"
    $name.VerticalAlignment = "Center"
    $name.Foreground = if ($m.mute -or $m.deaf) { $Script:MutedBrush } else { $Script:NameBrush }
    if ($m.speaking) { $name.FontWeight = "SemiBold" }
    [System.Windows.Controls.Grid]::SetColumn($name, 1)
    [void]$grid.Children.Add($name)

    $badges = New-Object System.Windows.Controls.StackPanel
    $badges.Orientation = "Horizontal"
    $badges.HorizontalAlignment = "Right"
    $badges.VerticalAlignment = "Center"
    if ($m.screen) { [void]$badges.Children.Add((New-Icon $Script:IconScreen 14 $Script:BadgeBrush $false)) }
    if ($m.cam)    { [void]$badges.Children.Add((New-Icon $Script:IconCam 14 $Script:BadgeBrush $false)) }
    if ($m.mute)   { [void]$badges.Children.Add((New-Icon $Script:IconMic 14 $Script:BadgeBrush $true)) }
    if ($m.deaf)   { [void]$badges.Children.Add((New-Icon $Script:IconHeadphones 14 $Script:BadgeBrush $true)) }
    [System.Windows.Controls.Grid]::SetColumn($badges, 2)
    [void]$grid.Children.Add($badges)

    $grid
}

# --- window -------------------------------------------------------------------
function New-OverlayWindow($cfg) {
    $win = New-Object System.Windows.Window
    $win.WindowStyle = "None"
    $win.AllowsTransparency = $true
    $win.Background = $Script:Transparent
    $win.Topmost = $true
    $win.ShowInTaskbar = $false
    $win.ResizeMode = "NoResize"
    $win.Width = $cfg.width
    $win.SizeToContent = "Height"
    $win.Left = $cfg.left
    $win.Top = $cfg.top
    $win.ShowActivated = $false

    $card = New-Object System.Windows.Controls.Border
    $card.CornerRadius = "10"
    $card.Background = $Script:CardBrush
    $card.BorderBrush = $Script:HairlineBrush
    $card.BorderThickness = "1"
    $card.Padding = "8,6,8,6"

    $root = New-Object System.Windows.Controls.StackPanel
    $card.Child = $root
    $win.Content = $card

    @{ Window = $win; Card = $card; Root = $root }
}

function Update-Overlay($ui, $snap) {
    $root = $ui.Root
    $root.Children.Clear()
    if (-not $snap -or -not $snap.channel) { if ($ui.Window.IsVisible) { $ui.Window.Hide() }; return }

    $head = New-Object System.Windows.Controls.Grid
    $a = New-Object System.Windows.Controls.ColumnDefinition; $a.Width = "*"
    $b = New-Object System.Windows.Controls.ColumnDefinition; $b.Width = "Auto"
    [void]$head.ColumnDefinitions.Add($a); [void]$head.ColumnDefinitions.Add($b)
    $title = New-Object System.Windows.Controls.TextBlock
    $title.Text = [string]$snap.channel
    $title.FontSize = 11
    $title.FontWeight = "SemiBold"
    $title.Foreground = $Script:MutedBrush
    $title.TextTrimming = "CharacterEllipsis"
    [void]$head.Children.Add($title)
    $count = New-Object System.Windows.Controls.TextBlock
    $count.Text = [string]$snap.count
    $count.FontSize = 11
    $count.Foreground = $Script:MutedBrush
    [System.Windows.Controls.Grid]::SetColumn($count, 1)
    [void]$head.Children.Add($count)
    [void]$root.Children.Add($head)

    foreach ($m in $snap.members) { [void]$root.Children.Add((New-MemberRow $m)) }

    if ($snap.log -and $snap.log.Count -gt 0) {
        $rule = New-Object System.Windows.Controls.Border
        $rule.BorderBrush = $Script:HairlineBrush
        $rule.BorderThickness = "0,1,0,0"
        $rule.Margin = "0,5,0,4"
        [void]$root.Children.Add($rule)
        foreach ($entry in $snap.log) {
            $t = New-Object System.Windows.Controls.TextBlock
            $t.Text = [string]$entry.text
            $t.FontSize = 10.5
            $t.TextTrimming = "CharacterEllipsis"
            $t.Foreground = if ($entry.kind -eq "leave") { $Script:LeaveBrush } else { $Script:MutedBrush }
            [void]$root.Children.Add($t)
        }
    }

    if (-not $ui.Window.IsVisible) { $ui.Window.Show() }
}

# --- click-through ------------------------------------------------------------
if (-not ("Win32Overlay" -as [type])) {
Add-Type -Namespace Win32 -Name Overlay -MemberDefinition @'
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
[DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
'@
}

function Set-ClickThrough($ui, [bool]$on) {
    $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper $ui.Window).Handle
    $GWL_EXSTYLE = -20
    $style = [Win32.Overlay]::GetWindowLong($hwnd, $GWL_EXSTYLE)
    $TRANSPARENT = 0x20
    $NOACTIVATE = 0x8000000
    if ($on) { $style = $style -bor $TRANSPARENT -bor $NOACTIVATE } else { $style = $style -band (-bnot ($TRANSPARENT -bor $NOACTIVATE)) }
    [void][Win32.Overlay]::SetWindowLong($hwnd, $GWL_EXSTYLE, $style)
    $Script:Locked = $on
}

# --- shared brushes -----------------------------------------------------------
$Script:Transparent   = [System.Windows.Media.Brushes]::Transparent
$Script:NameBrush     = Brush "#f2f3f5"
$Script:MutedBrush    = Brush "#b5bac1"
$Script:BadgeBrush    = Brush "#b5bac1"
$Script:SpeakBrush    = Brush "#23a55a"
$Script:LeaveBrush    = Brush "#ff8a8a"
$Script:HairlineBrush = Brush "#3f4147" 0.9
$Script:Locked        = $false

$cfg = Get-Config
$Script:CardBrush = Brush "#1e1f22" $cfg.opacity

function Format-Snapshot($snap) {
    if (-not $snap -or -not $snap.channel) { return "no channel" }
    $lines = @()
    $lines += ("{0}  ({1})" -f $snap.channel, $snap.count)
    foreach ($m in $snap.members) {
        $flags = @()
        if ($m.speaking) { $flags += "speaking" }
        if ($m.mute) { $flags += "muted" }
        if ($m.deaf) { $flags += "deafened" }
        if ($m.screen) { $flags += "screen" }
        if ($m.cam) { $flags += "camera" }
        $lines += ("  {0}{1}" -f $m.name, $(if ($flags.Count) { "  [" + ($flags -join ", ") + "]" } else { "" }))
    }
    foreach ($entry in $snap.log) { $lines += ("  log: {0}" -f $entry.text) }
    $lines -join "`n"
}

# --- headless: prove the data path works without a desktop -------------------
if ($Headless) {
    Write-Output ("settings: " + $cfg.settingsPath)
    $snap = Get-Snapshot $cfg.settingsPath
    if (-not $snap) { Write-Output "snapshot: none (plugin not exporting, or not in a voice channel)"; exit 0 }
    Write-Output (Format-Snapshot $snap)
    exit 0
}

[void][System.Windows.Application]::Current
$app = New-Object System.Windows.Application
$app.ShutdownMode = "OnExplicitShutdown"

$ui = New-OverlayWindow $cfg
$ui.Window.Add_MouseLeftButtonDown({
    param($s, $e)
    if (-not $Script:Locked) {
        try { $ui.Window.DragMove() } catch { }
        $cfg.left = [math]::Round($ui.Window.Left)
        $cfg.top = [math]::Round($ui.Window.Top)
        Save-Config $cfg
    }
})

# tray icon: lock/unlock click-through, reset position, exit
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = [System.Drawing.SystemIcons]::Application
$tray.Text = "Voice panel overlay"
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemLock = New-Object System.Windows.Forms.ToolStripMenuItem "Click-through (locked)"
$itemLock.CheckOnClick = $true
$itemReset = New-Object System.Windows.Forms.ToolStripMenuItem "Reset position"
$itemExit = New-Object System.Windows.Forms.ToolStripMenuItem "Exit"
[void]$menu.Items.Add($itemLock); [void]$menu.Items.Add($itemReset); [void]$menu.Items.Add($itemExit)
$tray.ContextMenuStrip = $menu
$tray.Visible = $true

$itemLock.add_Click({ Set-ClickThrough $ui $itemLock.Checked; $cfg.clickThrough = $itemLock.Checked; Save-Config $cfg })
$itemReset.add_Click({ $ui.Window.Left = 40; $ui.Window.Top = 120; $cfg.left = 40; $cfg.top = 120; Save-Config $cfg })
$itemExit.add_Click({ $tray.Visible = $false; $app.Shutdown() })

$Script:LastText = ""
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds($PollMs)
$timer.add_Tick({
    $snap = Get-Snapshot $cfg.settingsPath
    $text = if ($snap) { $snap | ConvertTo-Json -Depth 5 -Compress } else { "" }
    if ($text -eq $Script:LastText) { return }
    $Script:LastText = $text
    Update-Overlay $ui $snap
})

$ui.Window.Add_Loaded({
    Update-Overlay $ui (Get-Snapshot $cfg.settingsPath)
    if ($cfg.clickThrough) { $itemLock.Checked = $true; Set-ClickThrough $ui $true }
    $timer.Start()
    if ($DryRun) { $app.Shutdown() }
})

if (-not $DryRun) { $app.Run($ui.Window) } else { $app.Run() }
$tray.Visible = $false
