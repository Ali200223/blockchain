# =========================
# Week 4 Full Integration Demo
# Auth → KYC → Wallet → Trade → Ledger Proof
# + HARDENING: Trade reversal + Receipt ACL negative test
# PowerShell 5.1 compatible
# =========================

$ErrorActionPreference = "Stop"

# --- CONFIGURATION ---
$BaseUrl  = "http://localhost:5000"
$DeviceId = "dev-demo-1"

# Admin (seed user)
$AdminEmail    = "admin@example.com"
$AdminPassword = "Admin1234!Admin"

# New user credentials (unique email + unique phone)
$UserEmail    = ("user_{0}@example.com" -f ([guid]::NewGuid().ToString("N").Substring(0,10)))
$UserPassword = "User1234!User"

function New-UniquePhoneIT {
  # +39 + 10 digits (randomized) -> avoids UNIQUE(phone) collisions
  $n = Get-Random -Minimum 1000000000 -Maximum 1999999999
  return ("+39{0}" -f $n)
}
$UserPhone = New-UniquePhoneIT

# KYC payload
$KycFullName  = "Demo User"
$KycDob       = "2000-01-01"
$KycCountry   = "IT"
$KycDocType   = "PASSPORT"
$KycDocNumber = ("P{0}" -f (Get-Random -Minimum 10000000 -Maximum 99999999))

# Ledger commit batch size
$LedgerMaxItems = 500

# --- Helpers ---
function New-Guid { [guid]::NewGuid().ToString() }

function Invoke-ApiOnce {
  param(
    [Parameter(Mandatory=$true)][ValidateSet("GET","POST","PUT","PATCH","DELETE")] [string]$Method,
    [Parameter(Mandatory=$true)][string]$Path,
    [Parameter(Mandatory=$false)]$Body,
    [Parameter(Mandatory=$false)]$Tokens,
    [Parameter(Mandatory=$false)][string]$Label = "API",
    [Parameter(Mandatory=$false)][hashtable]$ExtraHeaders
  )

  $uri = "$BaseUrl$Path"

  $headers = @{
    "Accept"       = "application/json"
    "Content-Type" = "application/json"
    "x-device-id"  = $DeviceId
  }

  if ($Tokens -and $Tokens.access) {
    $headers["Authorization"] = "Bearer $($Tokens.access)"
  }

  if ($ExtraHeaders) {
    foreach ($k in $ExtraHeaders.Keys) { $headers[$k] = $ExtraHeaders[$k] }
  }

  try {
    if ($null -ne $Body) {
      $json = $Body | ConvertTo-Json -Depth 25
      $res  = Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -Body $json -TimeoutSec 30
    } else {
      $res  = Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -TimeoutSec 30
    }
    return @{ ok=$true; data=$res; status=200; raw=$null }
  } catch {
    $status = $null
    $raw = $null

    try { $status = $_.Exception.Response.StatusCode.value__ } catch { }
    try {
      if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $raw = $_.ErrorDetails.Message }
      else { $raw = $_.Exception.Message }
    } catch {
      $raw = $_.Exception.Message
    }

    return @{ ok=$false; data=$null; status=$status; raw=$raw }
  }
}

function Refresh-Tokens {
  param([ref]$Tokens,[string]$Label)

  if (-not $Tokens.Value -or -not $Tokens.Value.refresh) {
    throw "[$Label] Missing refresh token"
  }

  $body = @{ refresh = $Tokens.Value.refresh }
  $out  = Invoke-ApiOnce -Method "POST" -Path "/api/auth/refresh" -Body $body -Label "REFRESH_$Label"

  if (-not $out.ok) {
    throw "[$Label] Refresh failed (HTTP $($out.status)): $($out.raw)"
  }

  # support either {tokens:{...}} or direct {access,refresh}
  if ($out.data.tokens) { $Tokens.Value = $out.data.tokens }
  else { $Tokens.Value = $out.data }
}

function Invoke-Api {
  param(
    [Parameter(Mandatory=$true)][ValidateSet("GET","POST","PUT","PATCH","DELETE")] [string]$Method,
    [Parameter(Mandatory=$true)][string]$Path,
    [Parameter(Mandatory=$false)]$Body,
    [Parameter(Mandatory=$false)][ref]$Tokens,
    [Parameter(Mandatory=$false)][string]$Label = "API",
    [Parameter(Mandatory=$false)][hashtable]$ExtraHeaders
  )

  $tok = $null
  if ($Tokens) { $tok = $Tokens.Value }

  $res = Invoke-ApiOnce -Method $Method -Path $Path -Body $Body -Tokens $tok -Label $Label -ExtraHeaders $ExtraHeaders
  if ($res.ok) { return $res.data }

  if ($res.status -eq 401 -and $Tokens) {
    Write-Host "[$Label] Access expired/unauthorized → refreshing..." -ForegroundColor Yellow
    Refresh-Tokens -Tokens $Tokens -Label $Label
    $tok = $Tokens.Value

    $res = Invoke-ApiOnce -Method $Method -Path $Path -Body $Body -Tokens $tok -Label $Label -ExtraHeaders $ExtraHeaders
    if ($res.ok) { return $res.data }

    throw "[$Label] retry failed (HTTP $($res.status)): $($res.raw)"
  }

  throw "[$Label] API failed (HTTP $($res.status)): $($res.raw)"
}

function Login {
  param([string]$Email,[string]$Password,[ref]$Tokens,[string]$Label)

  $body = @{ email=$Email; password=$Password }
  $out  = Invoke-ApiOnce -Method "POST" -Path "/api/auth/login" -Body $body -Label "LOGIN_$Label"

  if (-not $out.ok) { throw "[LOGIN_$Label] failed (HTTP $($out.status)): $($out.raw)" }

  if ($out.data.tokens) { $Tokens.Value = $out.data.tokens }
  else { $Tokens.Value = $out.data }
}

function Get-Prop {
  param($Obj, [string[]]$Names)
  foreach ($n in $Names) {
    if ($Obj -and ($Obj.PSObject.Properties.Name -contains $n) -and $Obj.$n -ne $null) { return $Obj.$n }
  }
  return $null
}

# HARDENING helper: try multiple paths for the same action
function Invoke-Api-MultiPath {
  param(
    [Parameter(Mandatory=$true)][ValidateSet("GET","POST","PUT","PATCH","DELETE")] [string]$Method,
    [Parameter(Mandatory=$true)][string[]]$Paths,
    [Parameter(Mandatory=$false)]$Body,
    [Parameter(Mandatory=$false)][ref]$Tokens,
    [Parameter(Mandatory=$false)][string]$Label = "API_MULTI",
    [Parameter(Mandatory=$false)][hashtable]$ExtraHeaders
  )

  $last = $null

  foreach ($p in $Paths) {
    $tok = $null
    if ($Tokens) { $tok = $Tokens.Value }

    $res = Invoke-ApiOnce -Method $Method -Path $p -Body $Body -Tokens $tok -Label $Label -ExtraHeaders $ExtraHeaders
    $last = $res

    if ($res.ok) { return $res.data }

    # if token expired, refresh and retry SAME path once
    if ($res.status -eq 401 -and $Tokens) {
      Write-Host "[$Label] 401 on $p → refreshing..." -ForegroundColor Yellow
      Refresh-Tokens -Tokens $Tokens -Label $Label
      $tok = $Tokens.Value
      $res2 = Invoke-ApiOnce -Method $Method -Path $p -Body $Body -Tokens $tok -Label $Label -ExtraHeaders $ExtraHeaders
      $last = $res2
      if ($res2.ok) { return $res2.data }
    }

    # 404/405 => try next candidate path
    if ($res.status -eq 404 -or $res.status -eq 405) { continue }

    # any other error => hard fail
    throw "[$Label] API failed at $p (HTTP $($res.status)): $($res.raw)"
  }

  throw "[$Label] None of the paths worked. LastStatus=$($last.status) LastError=$($last.raw)"
}

# --- FLOW START ---

Write-Host "`n[1] Admin login..." -ForegroundColor Cyan
$AdminTokens = $null
Login -Email $AdminEmail -Password $AdminPassword -Tokens ([ref]$AdminTokens) -Label "ADMIN"
Write-Host "Admin logged in." -ForegroundColor Green

Write-Host "`n[2] Register new user..." -ForegroundColor Cyan
Write-Host ("Planned user email={0}, phone={1}" -f $UserEmail, $UserPhone) -ForegroundColor DarkGray

$regBody = @{ email=$UserEmail; password=$UserPassword; phone=$UserPhone }
$regOut  = Invoke-Api -Method "POST" -Path "/api/auth/register" -Body $regBody -Label "REGISTER"

# support either {user:{id}} or {userId}
$userObj = Get-Prop $regOut @("user")
$userId  = $null
if ($userObj) { $userId = Get-Prop $userObj @("id","userId") }
if (-not $userId) { $userId = Get-Prop $regOut @("userId","id") }

Write-Host ("User registered: {0}  (phone={1})  (id={2})" -f $UserEmail, $UserPhone, $userId) -ForegroundColor Green

Write-Host "`n[3] User login..." -ForegroundColor Cyan
$UserTokens = $null
Login -Email $UserEmail -Password $UserPassword -Tokens ([ref]$UserTokens) -Label "USER"
Write-Host "User login OK." -ForegroundColor Green

Write-Host "`n[4] Submit KYC..." -ForegroundColor Cyan
$kycBody = @{
  fullName=$KycFullName
  dob=$KycDob
  country=$KycCountry
  docType=$KycDocType
  docNumber=$KycDocNumber
}
$null = Invoke-Api -Method "POST" -Path "/api/kyc/submit" -Body $kycBody -Tokens ([ref]$UserTokens) -Label "KYC_SUBMIT"
Write-Host "KYC submitted." -ForegroundColor Green

Write-Host "`n[5] Admin approves KYC..." -ForegroundColor Cyan
$approveBody = @{ userId=$userId; decision="APPROVE"; notes="Approved for trading" }
$null = Invoke-Api -Method "POST" -Path "/api/kyc/admin/review" -Body $approveBody -Tokens ([ref]$AdminTokens) -Label "KYC_REVIEW"
Write-Host "KYC approved." -ForegroundColor Green

Write-Host "`n[6] Admin deposits seed funds..." -ForegroundColor Cyan
$refId = New-Guid
$depBody = @{
  userId=$userId
  type="DEPOSIT"
  amount=100
  description="initial funding"
  referenceId=$refId
}
$depOut = Invoke-Api -Method "POST" -Path "/api/wallet/admin/adjust" -Body $depBody -Tokens ([ref]$AdminTokens) -Label "WALLET_ADJUST"

$bal = Get-Prop $depOut @("balance","newBalance","balanceAfter")
if (-not $bal -and $depOut.wallet) { $bal = Get-Prop $depOut.wallet @("balance","newBalance","balanceAfter") }
Write-Host ("Deposit done. Balance now: {0}" -f $bal) -ForegroundColor Green

Write-Host "`n[7] User executes BUY trade..." -ForegroundColor Cyan
$buyRef = New-Guid
$buyBody = @{
  symbol="BTC"
  qty=0.001
  price=45000
  fee=1.00
  referenceId=$buyRef
}
$buyOut = Invoke-Api -Method "POST" -Path "/api/trade/buy" -Body $buyBody -Tokens ([ref]$UserTokens) -Label "TRADE_BUY"

$tradeObj = Get-Prop $buyOut @("trade")
$buyTradeId = $null
if ($tradeObj) { $buyTradeId = Get-Prop $tradeObj @("id","tradeId","fillId","tradeFillId") }
if (-not $buyTradeId) { $buyTradeId = Get-Prop $buyOut @("tradeId","id","fillId","tradeFillId") }

$walletObj = Get-Prop $buyOut @("wallet")
$buyBal = $null
if ($walletObj) { $buyBal = Get-Prop $walletObj @("balance","newBalance","balanceAfter") }
if (-not $buyBal) { $buyBal = Get-Prop $buyOut @("balance","newBalance","balanceAfter") }

# try to grab walletTxId from response (best-effort)
$buyWalletTxId =
  (Get-Prop $buyOut @("walletTxId","wallet_tx_id","walletTransactionId","txId"))
if (-not $buyWalletTxId -and $walletObj) {
  $buyWalletTxId = Get-Prop $walletObj @("walletTxId","txId","id")
}

Write-Host ("BUY ok. TradeId={0}, newBalance={1}, walletTxId={2}" -f $buyTradeId, $buyBal, $buyWalletTxId) -ForegroundColor Green

Write-Host "`n[8] User executes SELL trade..." -ForegroundColor Cyan
$sellRef = New-Guid
$sellBody = @{
  symbol="BTC"
  qty=0.0005
  price=46000
  fee=1.00
  referenceId=$sellRef
}
$sellOut = Invoke-Api -Method "POST" -Path "/api/trade/sell" -Body $sellBody -Tokens ([ref]$UserTokens) -Label "TRADE_SELL"

$sellTradeObj = Get-Prop $sellOut @("trade")
$sellTradeId = $null
if ($sellTradeObj) { $sellTradeId = Get-Prop $sellTradeObj @("id","tradeId","fillId","tradeFillId") }
if (-not $sellTradeId) { $sellTradeId = Get-Prop $sellOut @("tradeId","id","fillId","tradeFillId") }

$sellWalletObj = Get-Prop $sellOut @("wallet")
$sellBal = $null
if ($sellWalletObj) { $sellBal = Get-Prop $sellWalletObj @("balance","newBalance","balanceAfter") }
if (-not $sellBal) { $sellBal = Get-Prop $sellOut @("balance","newBalance","balanceAfter") }

$sellWalletTxId =
  (Get-Prop $sellOut @("walletTxId","wallet_tx_id","walletTransactionId","txId"))
if (-not $sellWalletTxId -and $sellWalletObj) {
  $sellWalletTxId = Get-Prop $sellWalletObj @("walletTxId","txId","id")
}

Write-Host ("SELL ok. TradeId={0}, newBalance={1}, walletTxId={2}" -f $sellTradeId, $sellBal, $sellWalletTxId) -ForegroundColor Green

Write-Host "`n[9] Commit next ledger block..." -ForegroundColor Cyan
$idemKey = New-Guid
$commitBody = @{ maxItems = $LedgerMaxItems }
$commitHeaders = @{ "Idempotency-Key" = $idemKey }

$commitOut = Invoke-Api -Method "POST" -Path "/api/ledger/admin/commit" -Body $commitBody -Tokens ([ref]$AdminTokens) -Label "LEDGER_COMMIT" -ExtraHeaders $commitHeaders

$h = Get-Prop $commitOut @("height")
$itemsCount = Get-Prop $commitOut @("itemsCount","items")
Write-Host ("Ledger committed height={0}, items={1}" -f $h, $itemsCount) -ForegroundColor Green

Write-Host "`n[10] Verify chain integrity..." -ForegroundColor Cyan
$verifyOut = Invoke-Api -Method "GET" -Path "/api/ledger/admin/verify?maxBlocks=2000" -Tokens ([ref]$AdminTokens) -Label "LEDGER_VERIFY"

$checked = Get-Prop $verifyOut @("checkedBlocks","verified")
$tipHeight = Get-Prop $verifyOut @("tipHeight")
if (-not $tipHeight -and $verifyOut.tip) { $tipHeight = Get-Prop $verifyOut.tip @("height") }

Write-Host ("Verify ok={0}, checkedBlocks={1}, tipHeight={2}" -f $verifyOut.ok, $checked, $tipHeight) -ForegroundColor Green

Write-Host "`n[11] Generate wallet receipt proof for BUY (ledger proof)..." -ForegroundColor Cyan
if ($buyWalletTxId) {
  $walletReceipt = Invoke-Api -Method "GET" -Path "/api/ledger/receipt/wallet/$buyWalletTxId" -Tokens ([ref]$UserTokens) -Label "RECEIPT_WALLET_BUY"
  $proofOk = $false
  if ($walletReceipt.verification) { $proofOk = [bool](Get-Prop $walletReceipt.verification @("proofOk")) }
  Write-Host ("Wallet receipt verified (proofOk={0})." -f $proofOk) -ForegroundColor Green
} else {
  Write-Host "Wallet receipt skipped: BUY response did not include walletTxId/txId." -ForegroundColor Yellow
}

# Optional: Trade receipt for BUY
if ($buyTradeId) {
  Write-Host "`n[12] Trade receipt proof for BUY (should be owner-or-admin)..." -ForegroundColor Cyan
  $r = Invoke-ApiOnce -Method "GET" -Path "/api/ledger/receipt/trade/$buyTradeId" -Tokens $UserTokens -Label "RECEIPT_TRADE_BUY_USER"
  if ($r.ok) {
    $proofOk = $false
    if ($r.data.verification) { $proofOk = [bool](Get-Prop $r.data.verification @("proofOk")) }
    Write-Host ("Trade receipt verified as USER (proofOk={0})." -f $proofOk) -ForegroundColor Green
  } else {
    Write-Host ("Trade receipt BUY failed as USER (HTTP {0}): {1}" -f $r.status, $r.raw) -ForegroundColor Yellow
    Write-Host "If this is 403, your ACL is not updated; if 404, receipt may not exist for that id." -ForegroundColor Yellow
  }
}

# ==========================
# HARDENING ADD-ON STARTS
# ==========================

Write-Host "`n[13] HARDENING: Reverse latest trade (we reverse SELL)..." -ForegroundColor Cyan
if (-not $sellTradeId) { throw "SELL trade id not found; cannot reverse." }

$revRef = New-Guid
$revBody = @{ referenceId = $revRef; reason = "demo reversal of latest sell" }

# Your router may be mounted at /api/trade OR /api/trades. Try both.
$revPaths = @(
  ("/api/trade/fills/{0}/reverse" -f $sellTradeId),
  ("/api/trades/fills/{0}/reverse" -f $sellTradeId)
)

$revOut = Invoke-Api-MultiPath -Method "POST" -Paths $revPaths -Body $revBody -Tokens ([ref]$UserTokens) -Label "TRADE_REVERSE"
$reversalWalletTxId = Get-Prop $revOut @("reversalWalletTxId","reversal_wallet_tx_id","walletTxId","walletTransactionId")
Write-Host ("Reversal OK. reversalWalletTxId={0}" -f $reversalWalletTxId) -ForegroundColor Green

Write-Host "`n[14] HARDENING: Commit ledger again to include reversal artifacts..." -ForegroundColor Cyan
$idemKey2 = New-Guid
$commitHeaders2 = @{ "Idempotency-Key" = $idemKey2 }
$commitOut2 = Invoke-Api -Method "POST" -Path "/api/ledger/admin/commit" -Body $commitBody -Tokens ([ref]$AdminTokens) -Label "LEDGER_COMMIT_2" -ExtraHeaders $commitHeaders2
$h2 = Get-Prop $commitOut2 @("height")
$itemsCount2 = Get-Prop $commitOut2 @("itemsCount","items")
Write-Host ("Ledger committed height={0}, items={1}" -f $h2, $itemsCount2) -ForegroundColor Green

Write-Host "`n[15] HARDENING: Verify chain integrity (after reversal)..." -ForegroundColor Cyan
$verifyOut2 = Invoke-Api -Method "GET" -Path "/api/ledger/admin/verify?maxBlocks=2000" -Tokens ([ref]$AdminTokens) -Label "LEDGER_VERIFY_2"
$checked2 = Get-Prop $verifyOut2 @("checkedBlocks","verified")
$tipHeight2 = Get-Prop $verifyOut2 @("tipHeight")
if (-not $tipHeight2 -and $verifyOut2.tip) { $tipHeight2 = Get-Prop $verifyOut2.tip @("height") }
Write-Host ("Verify ok={0}, checkedBlocks={1}, tipHeight={2}" -f $verifyOut2.ok, $checked2, $tipHeight2) -ForegroundColor Green

Write-Host "`n[16] HARDENING: Receipts after reversal (trade + reversal wallet tx)..." -ForegroundColor Cyan

# Trade receipt for the reversed SELL
$rSell = Invoke-ApiOnce -Method "GET" -Path ("/api/ledger/receipt/trade/{0}" -f $sellTradeId) -Tokens $UserTokens -Label "RECEIPT_TRADE_SELL_USER"
if ($rSell.ok) {
  $proofOk = $false
  if ($rSell.data.verification) { $proofOk = [bool](Get-Prop $rSell.data.verification @("proofOk")) }
  Write-Host ("SELL trade receipt verified as USER (proofOk={0})." -f $proofOk) -ForegroundColor Green
} else {
  Write-Host ("SELL trade receipt failed as USER (HTTP {0}): {1}" -f $rSell.status, $rSell.raw) -ForegroundColor Yellow
}

# Wallet receipt for the reversal wallet tx (this demonstrates the compensating tx is ledgered)
if ($reversalWalletTxId) {
  $rW = Invoke-ApiOnce -Method "GET" -Path ("/api/ledger/receipt/wallet/{0}" -f $reversalWalletTxId) -Tokens $UserTokens -Label "RECEIPT_WALLET_REV_USER"
  if ($rW.ok) {
    $proofOk = $false
    if ($rW.data.verification) { $proofOk = [bool](Get-Prop $rW.data.verification @("proofOk")) }
    Write-Host ("Reversal wallet receipt verified as USER (proofOk={0})." -f $proofOk) -ForegroundColor Green
  } else {
    Write-Host ("Reversal wallet receipt failed as USER (HTTP {0}): {1}" -f $rW.status, $rW.raw) -ForegroundColor Yellow
  }
} else {
  Write-Host "Reversal wallet receipt skipped: reversalWalletTxId not returned by API." -ForegroundColor Yellow
}

Write-Host "`n[17] HARDENING: Access-control negative test (non-owner must be forbidden)..." -ForegroundColor Cyan

# Create another user (no KYC required for this negative test)
$OtherEmail    = ("other_{0}@example.com" -f ([guid]::NewGuid().ToString("N").Substring(0,10)))
$OtherPassword = "User1234!User"
$OtherPhone    = New-UniquePhoneIT

$regOther = Invoke-ApiOnce -Method "POST" -Path "/api/auth/register" -Body @{ email=$OtherEmail; password=$OtherPassword; phone=$OtherPhone } -Label "REGISTER_OTHER"
if (-not $regOther.ok) { throw "[REGISTER_OTHER] failed (HTTP $($regOther.status)): $($regOther.raw)" }

$OtherTokens = $null
Login -Email $OtherEmail -Password $OtherPassword -Tokens ([ref]$OtherTokens) -Label "OTHER"
Write-Host ("Other user logged in: {0}" -f $OtherEmail) -ForegroundColor Green

# Non-owner trade receipt should be 403 (or 404 if you hide existence)
$denyTrade = Invoke-ApiOnce -Method "GET" -Path ("/api/ledger/receipt/trade/{0}" -f $sellTradeId) -Tokens $OtherTokens -Label "ACL_TRADE_NONOWNER"
Write-Host ("Non-owner trade receipt status: {0}" -f $denyTrade.status) -ForegroundColor DarkGray
if ($denyTrade.ok) { throw "ACL FAILED: non-owner could read trade receipt." }
if ($denyTrade.status -ne 403 -and $denyTrade.status -ne 404) { throw "Unexpected status for non-owner trade receipt: $($denyTrade.status) raw=$($denyTrade.raw)" }

# Non-owner wallet receipt for reversal tx should be 403/404
if ($reversalWalletTxId) {
  $denyWallet = Invoke-ApiOnce -Method "GET" -Path ("/api/ledger/receipt/wallet/{0}" -f $reversalWalletTxId) -Tokens $OtherTokens -Label "ACL_WALLET_NONOWNER"
  Write-Host ("Non-owner wallet receipt status: {0}" -f $denyWallet.status) -ForegroundColor DarkGray
  if ($denyWallet.ok) { throw "ACL FAILED: non-owner could read wallet receipt." }
  if ($denyWallet.status -ne 403 -and $denyWallet.status -ne 404) { throw "Unexpected status for non-owner wallet receipt: $($denyWallet.status) raw=$($denyWallet.raw)" }
}

Write-Host "`nALL steps done successfully (including hardening)." -ForegroundColor Green
