param(
    [string[]]$MediaPaths = @()
)

$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent $appDir
$tauriDir = Join-Path $appDir 'src-tauri'
$ffmpeg = Join-Path $projectDir 'ffmpeg\win\ffmpeg.exe'
$ffprobe = Join-Path $projectDir 'ffmpeg\win\ffprobe.exe'
$mpvSource = Join-Path $projectDir 'mpv\win'
$mpvBin = Join-Path $mpvSource '64'
$cargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
$playerExe = Join-Path $tauriDir 'target\debug\shadowencoder.exe'
$smokeTest = 'mpv_player::tests::smoke_decodes_controls_and_stops_a_local_file'
$expectedDisplaySizes = @{}
$gifInput = $null

foreach ($required in @($ffmpeg, $ffprobe, $cargo, (Join-Path $mpvBin 'libmpv-2.dll'))) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Required player test dependency is missing: $required"
    }
}

$env:MPV_SOURCE = $mpvSource
$env:PATH = "$env:USERPROFILE\.cargo\bin;$mpvBin;$projectDir\ffmpeg\win;$env:PATH"

function Invoke-Checked {
    param(
        [string]$Label,
        [scriptblock]$Command
    )
    Write-Host "[player-test] $Label"
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE"
    }
}

if ($MediaPaths.Count -eq 0) {
    $h264 = Join-Path $env:TEMP 'shadowencoder-player-h264.mp4'
    $hevcMain = Join-Path $env:TEMP 'shadowencoder-player-hevc-main.mp4'
    $hevcMain10 = Join-Path $env:TEMP 'shadowencoder-player-hevc-main10.mp4'
    $rotatedH264 = Join-Path $env:TEMP 'shadowencoder-player-h264-rotated.mp4'

    Invoke-Checked 'generate H.264 sample' {
        & $ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'testsrc2=size=1280x720:rate=60' `
            -t 5 -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p $h264
    }
    Invoke-Checked 'generate HEVC Main sample' {
        & $ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'testsrc2=size=1280x720:rate=60' `
            -t 5 -c:v libx265 -preset ultrafast -crf 20 -pix_fmt yuv420p -tag:v hvc1 `
            -x265-params 'log-level=error' $hevcMain
    }
    Invoke-Checked 'generate HEVC Main10 sample' {
        & $ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'testsrc2=size=1280x720:rate=60' `
            -t 5 -c:v libx265 -preset ultrafast -crf 20 -pix_fmt yuv420p10le -tag:v hvc1 `
            -x265-params 'log-level=error' $hevcMain10
    }
    Invoke-Checked 'generate rotated H.264 sample' {
        & $ffmpeg -hide_banner -loglevel error -y -display_rotation:v:0 90 `
            -i $h264 -c copy $rotatedH264
    }
    $expectedDisplaySizes[$rotatedH264] = @(720, 1280)
    $MediaPaths = @($h264, $hevcMain, $hevcMain10, $rotatedH264)
    $gifInput = $rotatedH264
}

$MediaPaths = @($MediaPaths | ForEach-Object {
    $resolved = (Resolve-Path -LiteralPath $_).Path
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        throw "Media file does not exist: $_"
    }
    $resolved
})

if (-not $gifInput) {
    $gifInput = $MediaPaths[0]
}

$gifPalette = Join-Path $env:TEMP ("shadowencoder-gif-palette-{0}.png" -f [guid]::NewGuid())
$gifOutput = Join-Path $env:TEMP ("shadowencoder-gif-contract-{0}.gif" -f [guid]::NewGuid())
try {
    Invoke-Checked "GIF palette smoke: $gifInput" {
        & $ffmpeg -hide_banner -loglevel error -y -ss 0 -t 2 -i $gifInput `
            -vf 'scale=480:688:flags=lanczos,fps=15,palettegen=reserve_transparent=1:stats_mode=diff' `
            -frames:v 1 $gifPalette
    }
    Invoke-Checked "GIF render smoke: $gifInput" {
        & $ffmpeg -hide_banner -loglevel error -y -ss 0 -t 2 -i $gifInput -i $gifPalette `
            -filter_complex '[0:v]scale=480:688:flags=lanczos,fps=15[frames];[frames][1:v]paletteuse=dither=sierra2_4a' `
            -loop 0 $gifOutput
    }
    $gifProbe = & $ffprobe -v error -select_streams v:0 -count_frames `
        -show_entries 'stream=codec_name,width,height,r_frame_rate,nb_read_frames:format=duration' `
        -of json $gifOutput | ConvertFrom-Json
    $gifStream = $gifProbe.streams[0]
    if ($LASTEXITCODE -ne 0 -or $gifStream.codec_name -ne 'gif' -or $gifStream.width -ne 480 `
        -or $gifStream.height -ne 688 -or $gifStream.r_frame_rate -ne '15/1' `
        -or [int]$gifStream.nb_read_frames -ne 30 -or [double]$gifProbe.format.duration -ne 2.0) {
        throw "GIF contract returned unexpected metadata: $($gifProbe | ConvertTo-Json -Depth 4 -Compress)"
    }
    Write-Host '[player-test] GIF_CONTRACT_PASS codec=gif size=480x688 fps=15 frames=30 duration=2'
}
finally {
    Remove-Item -LiteralPath $gifPalette, $gifOutput -Force -ErrorAction SilentlyContinue
}

Push-Location $tauriDir
try {
    foreach ($mediaPath in $MediaPaths) {
        $env:SHADOWENCODER_MPV_SMOKE_FILE = $mediaPath
        $expectedSize = $expectedDisplaySizes[$mediaPath]
        if ($expectedSize) {
            $env:SHADOWENCODER_MPV_EXPECT_WIDTH = [string]$expectedSize[0]
            $env:SHADOWENCODER_MPV_EXPECT_HEIGHT = [string]$expectedSize[1]
        }
        else {
            Remove-Item Env:SHADOWENCODER_MPV_EXPECT_WIDTH -ErrorAction SilentlyContinue
            Remove-Item Env:SHADOWENCODER_MPV_EXPECT_HEIGHT -ErrorAction SilentlyContinue
        }
        Invoke-Checked "core decode smoke: $mediaPath" {
            & $cargo test $smokeTest -- --ignored --exact --nocapture
        }
    }

    Invoke-Checked 'build native player' { & $cargo build }

    foreach ($mediaPath in $MediaPaths) {
        $stdout = Join-Path $env:TEMP ("shadowencoder-gpu-smoke-{0}.stdout.log" -f [guid]::NewGuid())
        $stderr = Join-Path $env:TEMP ("shadowencoder-gpu-smoke-{0}.stderr.log" -f [guid]::NewGuid())
        try {
            $env:SHADOWENCODER_MPV_GPU_SMOKE_FILE = $mediaPath
            $env:SHADOWENCODER_MPV_GPU_SMOKE_EXIT = '1'
            $env:SHADOWENCODER_MPV_DEBUG = '1'
            $process = Start-Process -FilePath $playerExe -WindowStyle Hidden -Wait -PassThru `
                -RedirectStandardOutput $stdout -RedirectStandardError $stderr
            $output = ((Get-Content -LiteralPath $stdout -Raw -ErrorAction SilentlyContinue) +
                (Get-Content -LiteralPath $stderr -Raw -ErrorAction SilentlyContinue)).Trim()
            if ($output) {
                Write-Host $output
            }
            if ($process.ExitCode -ne 0 -or $output -notmatch 'GPU_SMOKE_PASS' `
                -or $output -notmatch 'GPU_SELECTION_PASS rect=8,8,24,24') {
                throw "GPU smoke failed for $mediaPath (exit code $($process.ExitCode))"
            }
            $expectedSize = $expectedDisplaySizes[$mediaPath]
            if ($expectedSize -and $output -notmatch ("size={0}x{1}" -f $expectedSize[0], $expectedSize[1])) {
                throw "GPU smoke returned the wrong display size for rotated media: $output"
            }
        }
        finally {
            Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
        }
    }
}
finally {
    Pop-Location
    Remove-Item Env:SHADOWENCODER_MPV_SMOKE_FILE -ErrorAction SilentlyContinue
    Remove-Item Env:SHADOWENCODER_MPV_GPU_SMOKE_FILE -ErrorAction SilentlyContinue
    Remove-Item Env:SHADOWENCODER_MPV_GPU_SMOKE_EXIT -ErrorAction SilentlyContinue
    Remove-Item Env:SHADOWENCODER_MPV_DEBUG -ErrorAction SilentlyContinue
    Remove-Item Env:SHADOWENCODER_MPV_EXPECT_WIDTH -ErrorAction SilentlyContinue
    Remove-Item Env:SHADOWENCODER_MPV_EXPECT_HEIGHT -ErrorAction SilentlyContinue
}

Write-Host "[player-test] PASS ($($MediaPaths.Count) media files)"
