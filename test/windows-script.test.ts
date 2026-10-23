import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
test('Windows PowerShell scripts parse without executing extraction or scheduling', {skip:process.platform!=='win32'},()=>{
  for(const file of ['sync-hotcopy-windows.ps1','register-hotcopy-task.ps1','register-nightly-recovery-task.ps1']) {
    const path=fileURLToPath(new URL(`../scripts/${file}`,import.meta.url));
    const command=`$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile('${path.replaceAll("'","''")}',[ref]$tokens,[ref]$errors) | Out-Null; if($errors.Count) { $errors | Out-String | Write-Error; exit 1 }`;
    execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{stdio:'pipe'});
  }
});

test('a shared log reader cannot fail a validated Windows import', {skip:process.platform!=='win32'},()=>{
  const path=fileURLToPath(new URL('../scripts/sync-hotcopy-windows.ps1',import.meta.url)).replaceAll("'","''");
  const command=`$tokens=$null; $errors=$null; $ast=[System.Management.Automation.Language.Parser]::ParseFile('${path}',[ref]$tokens,[ref]$errors); $function=$ast.Find({param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq 'Write-RunLog'},$true); . ([ScriptBlock]::Create($function.Extent.Text)); $log=[IO.Path]::GetTempFileName(); try { $reader=[IO.FileStream]::new($log,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try { Write-RunLog 'import stays complete' } finally { $reader.Dispose() }; Write-RunLog 'log is writable again'; if(-not [IO.File]::ReadAllText($log).Contains('log is writable again')) { throw 'log did not resume' }; 'LOG_CHECK_OK' } finally { Remove-Item -LiteralPath $log -Force }`;
  const output=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8'});
  assert.match(output,/import stays complete/);assert.match(output,/LOG_CHECK_OK/);
});
