# ============================================================
# Group Management E2E Test (ASCII-only, safe for PS 5.1)
# Run:
#   powershell -ExecutionPolicy Bypass -File test-groups.ps1
# ============================================================
$ErrorActionPreference = 'Continue'
$base = 'http://localhost:9091/api/v1'

function Call-Api {
  param($method, $path, $body = $null, $token = $null)
  $headers = @{'Content-Type' = 'application/json'}
  if ($token) { $headers['Authorization'] = "Bearer $token" }
  $params = @{ Method = $method; Uri = "$base$path"; Headers = $headers }
  if ($body) { $params['Body'] = ($body | ConvertTo-Json -Depth 5) }
  try {
    return Invoke-RestMethod @params
  } catch {
    $resp = $_.Exception.Response
    if ($resp) {
      $stream = $resp.GetResponseStream()
      $reader = New-Object System.IO.StreamReader($stream)
      $bodyText = $reader.ReadToEnd()
      Write-Host "FAIL HTTP $($resp.StatusCode.value__): $bodyText" -ForegroundColor Red
    } else {
      Write-Host "FAIL Exception: $($_.Exception.Message)" -ForegroundColor Red
    }
    return $null
  }
}

# Pick helper: walk a path of property names, return null if any missing
function Pick($obj, [string[]]$path) {
  $cur = $obj
  foreach ($p in $path) {
    if ($null -eq $cur) { return $null }
    if ($cur.PSObject.Properties.Name -notcontains $p) { return $null }
    $cur = $cur.$p
  }
  return $cur
}

function Get-Token($r) {
  $t = Pick $r @('data','data','access_token')
  if (-not $t) { $t = Pick $r @('data','access_token') }
  if (-not $t) { $t = Pick $r @('access_token') }
  return $t
}
function Get-UserId($r) {
  $u = Pick $r @('data','data','user','id')
  if (-not $u) { $u = Pick $r @('data','user','id') }
  if (-not $u) { $u = Pick $r @('user','id') }
  if (-not $u) { $u = Pick $r @('data','id') }
  if (-not $u) { $u = Pick $r @('id') }
  return $u
}

# ============== Step 0: Create PHONE_B test account ==============
Write-Host "`n===== Step 0: Create PHONE_B 13800000001 account =====" -ForegroundColor Cyan
$sql = "INSERT INTO app_users (id, phone, password_hash, display_name, role, status, force_change_pwd, created_at, updated_at) SELECT UUID(), '13800000001', password_hash, 'k6-B', 'user', 'active', false, NOW(), NOW() FROM app_users WHERE phone='13800000000';"
& "C:\mysql8\bin\mysql.exe" -uroot -proot burnmsg -e $sql
Write-Host "OK PHONE_B 13800000001 / Test@123456 created" -ForegroundColor Green

# ============== Step 1: Login A ==============
Write-Host "`n===== Step 1: Login A (admin 13800000000) =====" -ForegroundColor Cyan
$loginA = Call-Api POST '/auth/login' @{ phone='13800000000'; password='Test@123456'; device_name='test-script'; device_type='desktop' }
if ($null -eq $loginA) { Write-Host "FAIL A login abort" -ForegroundColor Red; exit 1 }
$tokenA = Get-Token $loginA
$userIdA = Get-UserId $loginA
Write-Host "userIdA = $userIdA" -ForegroundColor Yellow
Write-Host "tokenA (first 30) = $($tokenA.Substring(0, [Math]::Min(30, $tokenA.Length)))..." -ForegroundColor Yellow
Write-Host "Full loginA response:" -ForegroundColor Gray
$loginA | ConvertTo-Json -Depth 5

# ============== Step 2: Login B ==============
Write-Host "`n===== Step 2: Login B (k6-B 13800000001) =====" -ForegroundColor Cyan
$loginB = Call-Api POST '/auth/login' @{ phone='13800000001'; password='Test@123456'; device_name='test-script'; device_type='desktop' }
if ($null -eq $loginB) { Write-Host "FAIL B login abort" -ForegroundColor Red; exit 1 }
$tokenB = Get-Token $loginB
$userIdB = Get-UserId $loginB
Write-Host "userIdB = $userIdB" -ForegroundColor Yellow
Write-Host "Full loginB response:" -ForegroundColor Gray
$loginB | ConvertTo-Json -Depth 5

# ============== Step 3: A creates group with B as member ==============
Write-Host "`n===== Step 3: A creates group (with B as member) =====" -ForegroundColor Cyan
$create = Call-Api POST '/groups' @{ name='test-group-mgmt'; description='auto test'; member_ids=@($userIdB) } $tokenA
if ($null -eq $create) { Write-Host "FAIL create group abort" -ForegroundColor Red; exit 1 }
$convId = $create.id
if (-not $convId) { $convId = $create.data.id }
Write-Host "convId = $convId" -ForegroundColor Yellow
Write-Host "Full create response:" -ForegroundColor Gray
$create | ConvertTo-Json -Depth 5

# ============== Step 4: List group members (verify display_name/avatar) ==============
Write-Host "`n===== Step 4: List group members (verify display_name/avatar_url) =====" -ForegroundColor Cyan
Write-Host "Expected: A=owner, B=member, both have display_name" -ForegroundColor Gray
$members = Call-Api GET "/groups/$convId/members" $null $tokenA
if ($null -eq $members) { Write-Host "FAIL list members" -ForegroundColor Red } else {
  $members | ConvertTo-Json -Depth 5
  $roleA = ($members | Where-Object { $_.user_id -eq $userIdA }).role
  $roleB = ($members | Where-Object { $_.user_id -eq $userIdB }).role
  $nameB = ($members | Where-Object { $_.user_id -eq $userIdB }).display_name
  $avatarB = ($members | Where-Object { $_.user_id -eq $userIdB }).avatar_url
  if ($roleA -eq 'owner' -and $roleB -eq 'member' -and $nameB) {
    Write-Host "OK roles correct: A=owner, B=member; B.display_name=$nameB" -ForegroundColor Green
  } else {
    Write-Host "WARN roles/fields: roleA=$roleA roleB=$roleB nameB=$nameB avatarB=$avatarB" -ForegroundColor Yellow
  }
}

# ============== Step 5: A transfers ownership to B ==============
Write-Host "`n===== Step 5: A transfers ownership to B =====" -ForegroundColor Cyan
Write-Host "Expected: 200, oldOwnerId=A, newOwnerId=B" -ForegroundColor Gray
$transfer = Call-Api POST "/groups/$convId/transfer" @{ new_owner_id=$userIdB } $tokenA
if ($null -eq $transfer) { Write-Host "FAIL transfer" -ForegroundColor Red } else {
  $transfer | ConvertTo-Json -Depth 5
}

# ============== Step 6: List members again (verify A->admin, B->owner) ==============
Write-Host "`n===== Step 6: List members again (verify A->admin, B->owner) =====" -ForegroundColor Cyan
$members2 = Call-Api GET "/groups/$convId/members" $null $tokenA
if ($null -eq $members2) { Write-Host "FAIL list members" -ForegroundColor Red } else {
  $members2 | ConvertTo-Json -Depth 5
  $roleA2 = ($members2 | Where-Object { $_.user_id -eq $userIdA }).role
  $roleB2 = ($members2 | Where-Object { $_.user_id -eq $userIdB }).role
  if ($roleA2 -eq 'admin' -and $roleB2 -eq 'owner') {
    Write-Host "OK post-transfer roles correct: A=admin, B=owner" -ForegroundColor Green
  } else {
    Write-Host "WARN roles: roleA=$roleA2 roleB=$roleB2" -ForegroundColor Yellow
  }
}

# ============== Step 7: B dissolves the group ==============
Write-Host "`n===== Step 7: B dissolves group (B is now owner) =====" -ForegroundColor Cyan
Write-Host "Expected: 200, { dissolved: true }" -ForegroundColor Gray
$dissolve = Call-Api DELETE "/groups/$convId" $null $tokenB
if ($null -eq $dissolve) { Write-Host "FAIL dissolve" -ForegroundColor Red } else {
  $dissolve | ConvertTo-Json -Depth 5
}

# ============== Step 8: Verify DB soft-delete state ==============
Write-Host "`n===== Step 8: SQL verify soft-delete state =====" -ForegroundColor Cyan
& "C:\mysql8\bin\mysql.exe" -uroot -proot burnmsg -e "SELECT id, name, is_active, dissolved_at, dissolved_by, owner_id FROM conversations WHERE id='$convId';"
& "C:\mysql8\bin\mysql.exe" -uroot -proot burnmsg -e "SELECT user_id, role FROM conversation_members WHERE conversation_id='$convId';"
Write-Host "Expected: is_active=0, dissolved_at/dissolved_by set, member.role owner->admin" -ForegroundColor Gray

# ============== Step 9: A tries to list dissolved group members ==============
Write-Host "`n===== Step 9: A tries to list dissolved group members =====" -ForegroundColor Cyan
Write-Host "Expected: rejected (minor bug A might allow it through)" -ForegroundColor Gray
$members3 = Call-Api GET "/groups/$convId/members" $null $tokenA
if ($null -eq $members3) {
  Write-Host "OK rejected (no minor bug A)" -ForegroundColor Green
} else {
  Write-Host "WARN still accessible - confirms minor bug A exists" -ForegroundColor Yellow
  $members3 | ConvertTo-Json -Depth 5
}

Write-Host "`n===== ALL TESTS DONE =====" -ForegroundColor Green
Write-Host "Paste full output to agent for review" -ForegroundColor Green
