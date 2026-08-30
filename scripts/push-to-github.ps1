# FN Music PC 推送 GitHub 脚本
# 用法：在你自己的电脑上（有正常网络）运行本脚本
$ErrorActionPreference = 'Stop'
$repo = "https://github.com/JuuWaii/fnmusic_pc.git"

Write-Host "=== FN Music PC 推送 GitHub ===" -ForegroundColor Cyan
Write-Host "仓库: $repo"

# 1. 检查远程是否已配置
$hasRemote = git remote | Select-String -Pattern "^origin$"
if (-not $hasRemote) {
  git remote add origin $repo
  Write-Host "已添加远程 origin" -ForegroundColor Green
} else {
  git remote set-url origin $repo
  Write-Host "已更新远程 origin URL" -ForegroundColor Green
}

# 2. 推送前最终隐私检查
Write-Host "`n--- 推送前隐私检查 ---"
node scripts\check-privacy.js
if ($LASTEXITCODE -ne 0) {
  Write-Host "`n隐私检查失败！请先处理违规内容，不要推送。" -ForegroundColor Red
  exit 1
}

# 3. 推送
Write-Host "`n--- 推送到 GitHub ---"
git push -u origin master
if ($LASTEXITCODE -eq 0) {
  Write-Host "`n✅ 推送成功！" -ForegroundColor Green
  Write-Host "仓库地址: $repo"
} else {
  Write-Host "`n推送失败。若因代理问题，请检查代理软件是否运行，或执行:" -ForegroundColor Yellow
  Write-Host "  git config --global --unset http.proxy"
  Write-Host "  git config --global --unset https.proxy"
}
