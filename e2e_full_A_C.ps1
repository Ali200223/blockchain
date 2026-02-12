param(
  [string]$ABaseUrl = "http://127.0.0.1:5000",
  [string]$CBaseUrl = "http://127.0.0.1:4000",

  # Admin creds for Person A (used for KYC approve + wallet funding + ledger verify)
  [string]$AdminEmail = $(if ($env:ADMIN_SEED_EMAIL) { $env:ADMIN_SEED_EMAIL } else { "admin@example.com" }),
  [string]$AdminPassword = $(if ($env:ADMIN_SEED_PASSWORD) { $env:ADMIN_SEED_PASSWORD } else { "Admin1234!Admin" }),

  # Trade to attempt via Person C
  [string]$TradeSymbol = "BTCUSDT",
  [ValidateSet("BUY","SELL")]
  [string]$TradeSide = "BUY",
  [double]$TradeQty = 0.001,

  # Wallet deposit (Person A admin adjust)
  [double]$DepositAmount = 2000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# -----------------------------
# Helpers
# -----------------------------
$script:Steps = New-Object System.Collections.Generic.List[object]

function Add-Step {
  param(
    [string]$Name,
    [bool]$Ok,
    [string]$Details = ""
  )
  $script:Steps.Add([pscustomobject]@{
    Step    = $Name
    Result  = $(if ($Ok) { "PASS" } else { "FAIL" })
    Details = $Details
  }) | Out-Null
}

function Get-SafeCount($x) {
  if ($null -eq $x) { return 0 }
  if ($x -is [System.Collections.ICollection]) { return $x.Count }
  return @($x).Count
}

function Read-HttpErrorBody {
  param($Exception)

  # PS7+: HttpResponseMessage path
  try {
    if ($Exception.PSObject.Properties.Name -contains "Response" -and $null -ne $Exception.Response) {
      $resp = $Exception.Response

      if ($resp -is [System.Net.Http.HttpResponseMessage]) {
        if ($resp.Content) {
          return $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        }
      }

      # Windows PowerShell 5.1: HttpWebResponse path
      if ($resp.PSObject.Properties.Name -contains "GetResponseStream") {
        $stream = $resp.GetResponseStream()
        if ($stream) {
          $sr = New-Object System.IO.StreamReader($stream)
          $txt = $sr.ReadToEnd()
          $sr.Close()
          return $txt
        }
      }
    }
  } catch {}

  # Fallback: sometimes present
  try {
    if ($Exception.PSObject.Properties.Name -contains "ErrorDetails" -and $Exception.ErrorDetails -and $Exception.ErrorDetails.Message) {
      return $Exception.ErrorDetails.Message
    }
  } catch {}

  return $null
}

function Invoke-Json {
  param(
    [ValidateSet("GET","POST","PUT","PATCH","DELETE")]
    [string]$Method,
    [string]$Url,
    [hashtable]$Headers = @{},
    $Body = $null,
    [int]$TimeoutSec = 25
  )

  $payload = $null
  if ($null -ne $Body) {
    $payload = ($Body | ConvertTo-Json -Depth 12)
  }

  try {
    $iwrParams = @{
      Method      = $Method
      Uri         = $Url
      Headers     = $Headers
      TimeoutSec  = $TimeoutSec
      ContentType = "application/json"
      ErrorAction = "Stop"
    }

    if ($null -ne $payload) { $iwrParams.Body = $payload }

    # Windows PowerShell 5.1 compatibility (PS7 removed UseBasicParsing)
    $cmd = Get-Command Invoke-WebRequest
    if ($cmd.Parameters.ContainsKey("UseBasicParsing")) {
      $iwrParams.UseBasicParsing = $true
    }

    $resp = Invoke-WebRequest @iwrParams

    $text = $resp.Content
    $json = $null
    try { $json = $text | ConvertFrom-Json } catch {}

    return [pscustomobject]@{
      ok      = $true
      status  = [int]$resp.StatusCode
      raw     = $text
      body    = $json
      headers = $resp.Headers
    }
  }
  catch {
    $ex = $_.Exception
    $status = $null

    try {
      if ($ex.PSObject.Properties.Name -contains "Response" -and $null -ne $ex.Response) {
        $sc = $ex.Response.StatusCode
        if ($sc -is [int]) { $status = $sc } else { $status = [int]$sc }
      }
    } catch {}

    $errBody = Read-HttpErrorBody -Exception $ex

    return [pscustomobject]@{
      ok     = $false
      status = $status
      raw    = $errBody
      body   = $null
      error  = $ex.Message
    }
  }
}

function Require-Ok {
  param(
    [string]$StepName,
    $Resp,
    [string]$HintOnFail = ""
  )

  if ($Resp.ok) {
    Add-Step $StepName $true ("HTTP " + $Resp.status)
    return
  }

  $detail = "HTTP " + $Resp.status + " :: " + $Resp.error
  if ($Resp.raw) { $detail += " :: " + ($Resp.raw -replace "\s+"," ") }
  if ($HintOnFail) { $detail += " :: hint=" + $HintOnFail }

  Add-Step $StepName $false $detail
  throw ("E2E aborted at step: " + $StepName)
}

function New-RandomEmail {
  $ts = Get-Date -Format "yyyyMMdd_HHmmss"
  return "e2e_user_$ts@local.test"
}

function New-RandomPhone {
  $rand = Get-Random -Minimum 1000000000 -Maximum 1999999999
  return "$rand"
}

function Bearer($token) {
  return @{
    Authorization = "Bearer $token"
    "x-device-id" = "e2e-ps"
  }
}

# -----------------------------
# Start E2E
# -----------------------------
$exitCode = 0

try {
  Write-Host "== E2E A+C starting =="

  # 0) Health checks
  $aHealth = Invoke-Json -Method GET -Url "$ABaseUrl/health"
  Require-Ok "A health" $aHealth "Start Person A server (expected /health)."

  $cHealth = Invoke-Json -Method GET -Url "$CBaseUrl/health"
  if ($cHealth.ok) {
    Add-Step "C health" $true ("HTTP " + $cHealth.status)
  } else {
    Add-Step "C health" $false ("HTTP " + $cHealth.status + " :: " + $cHealth.error + " (will skip C trade checks)")
  }

  # 1) Register user on Person A
  $email = New-RandomEmail
  $phone = New-RandomPhone
  $password = "Test1234!Test123"  # >= 12 chars

  $reg = Invoke-Json -Method POST -Url "$ABaseUrl/api/auth/register" -Body @{
    email    = $email
    phone    = $phone
    password = $password
  }
  Require-Ok "A register user" $reg "Auth validator requires {email, phone, password>=12}."

  # 2) Login user on Person A
  $login = Invoke-Json -Method POST -Url "$ABaseUrl/api/auth/login" -Body @{
    email    = $email
    password = $password
  }
  Require-Ok "A login user" $login

  $userAccess = $login.body.tokens.access
  if (-not $userAccess) { throw "Login response missing tokens.access" }

  # 3) Get /me to capture userId
  $me = Invoke-Json -Method GET -Url "$ABaseUrl/api/auth/me" -Headers (Bearer $userAccess)
  Require-Ok "A user me" $me
  $userId = $me.body.user.id
  if (-not $userId) { throw "/api/auth/me missing user.id" }

  # 4) Admin login on Person A
  $adminLogin = Invoke-Json -Method POST -Url "$ABaseUrl/api/auth/login" -Body @{
    email    = $AdminEmail
    password = $AdminPassword
  }
  Require-Ok "A login admin" $adminLogin "Ensure ADMIN_SEED_EMAIL/ADMIN_SEED_PASSWORD are correct and admin user exists."

  $adminAccess = $adminLogin.body.tokens.access
  if (-not $adminAccess) { throw "Admin login missing tokens.access" }

  $adminMe = Invoke-Json -Method GET -Url "$ABaseUrl/api/auth/me" -Headers (Bearer $adminAccess)
  Require-Ok "A admin me" $adminMe

  $adminRole = $adminMe.body.user.role
  if ("$adminRole" -ne "admin") {
    Add-Step "A admin role check" $false ("role=" + $adminRole + " (KYC/wallet admin endpoints require role === 'admin')")
    throw "Admin role mismatch. Your admin user role must be 'admin'."
  } else {
    Add-Step "A admin role check" $true "role=admin"
  }

  # 5) Submit KYC as user
  $kycSubmit = Invoke-Json -Method POST -Url "$ABaseUrl/api/kyc/submit" -Headers (Bearer $userAccess) -Body @{
    fullName  = "Pranav"
    dob       = "1999-01-01"
    country   = "IT"
    docType   = "PASSPORT"
    docNumber = "P" + (Get-Random -Minimum 1000000 -Maximum 9999999)
  }
  Require-Ok "A KYC submit" $kycSubmit

  # 6) Admin approves KYC
  $kycReview = Invoke-Json -Method POST -Url "$ABaseUrl/api/kyc/admin/review" -Headers (Bearer $adminAccess) -Body @{
    userId   = $userId
    decision = "APPROVE"
    notes    = "E2E approve"
  }
  Require-Ok "A KYC admin approve" $kycReview

  # 7) User checks KYC status
  $kycStatus = Invoke-Json -Method GET -Url "$ABaseUrl/api/kyc/status" -Headers (Bearer $userAccess)
  Require-Ok "A KYC status" $kycStatus

  # 8) Admin deposits wallet funds (Person A)
  $depositRef = [guid]::NewGuid().ToString()
  $walletAdj = Invoke-Json -Method POST -Url "$ABaseUrl/api/wallet/admin/adjust" -Headers (Bearer $adminAccess) -Body @{
    userId      = $userId
    type        = "DEPOSIT"
    amount      = $DepositAmount
    description = "E2E deposit"
    referenceId = $depositRef
  }
  Require-Ok "A wallet admin deposit" $walletAdj

  # 9) User checks wallet
  $walletMe = Invoke-Json -Method GET -Url "$ABaseUrl/api/wallet/me" -Headers (Bearer $userAccess)
  Require-Ok "A wallet me" $walletMe

  # 10) Ledger commit + verify (admin)
  $commit = Invoke-Json -Method POST -Url "$ABaseUrl/api/ledger/admin/commit" -Headers (Bearer $adminAccess) -Body @{}
  Require-Ok "A ledger commit" $commit

  $verify = Invoke-Json -Method GET -Url "$ABaseUrl/api/ledger/admin/verify" -Headers (Bearer $adminAccess)
  Require-Ok "A ledger verify" $verify

  # 11) Person C trade flow (only if C health OK)
  if ($cHealth.ok) {
    $cTrade = Invoke-Json -Method POST -Url "$CBaseUrl/api/trades/execute_trade" -Headers (Bearer $userAccess) -Body @{
      symbol   = $TradeSymbol
      side     = $TradeSide
      quantity = $TradeQty
    }

    if ($cTrade.ok) {
      Add-Step "C execute_trade" $true ("HTTP " + $cTrade.status)

      # Verify trade appears in C's list
      $cTrades = Invoke-Json -Method GET -Url "$CBaseUrl/api/trades/get_trades" -Headers (Bearer $userAccess)
      Require-Ok "C get_trades" $cTrades

      $found = $false
      try {
        foreach ($t in $cTrades.body) {
          if ($t.symbol -eq $TradeSymbol) { $found = $true; break }
        }
      } catch {}

      if ($found) {
        Add-Step "C trades contains symbol" $true $TradeSymbol
      } else {
        Add-Step "C trades contains symbol" $false ("Did not find " + $TradeSymbol + " in get_trades output")
        throw "C trade did not appear in C trades list."
      }

      # Commit + verify after trade as well
      $commit2 = Invoke-Json -Method POST -Url "$ABaseUrl/api/ledger/admin/commit" -Headers (Bearer $adminAccess) -Body @{}
      Require-Ok "A ledger commit (post-trade)" $commit2

      $verify2 = Invoke-Json -Method GET -Url "$ABaseUrl/api/ledger/admin/verify" -Headers (Bearer $adminAccess)
      Require-Ok "A ledger verify (post-trade)" $verify2
    }
    else {
      $rawPart = ""
      if ($cTrade.raw) { $rawPart = " :: " + (($cTrade.raw) -replace "\s+"," ") }

      Add-Step "C execute_trade" $false ("HTTP " + $cTrade.status + " :: " + $cTrade.error + $rawPart)
      throw "C execute_trade failed. Check C authJwt wiring and A<->C gateway configuration."
    }
  } else {
    Add-Step "C trade flow" $false "Skipped because C /health failed."
  }

  Write-Host "`n== E2E completed successfully =="
}
catch {
  $exitCode = 1
  Write-Host "`n== E2E FAILED =="
  Write-Host $_.Exception.Message

  # Make sure the summary reflects that the run failed even if no step was marked FAIL
  try {
    Add-Step "Script error" $false $_.Exception.Message
  } catch {}
}
finally {
  Write-Host "`n--- SUMMARY ---"
  $script:Steps | Format-Table -AutoSize

  $fails = Get-SafeCount ($script:Steps | Where-Object { $_.Result -eq "FAIL" })

  if ($fails -gt 0) {
    Write-Host "`nFailures: $fails"
  } else {
    Write-Host "`nAll steps passed."
  }

  exit $exitCode
}
