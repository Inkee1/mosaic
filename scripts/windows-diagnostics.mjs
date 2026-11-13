import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export async function windowsDiagnostics(executable) {
  if (process.platform !== 'win32') return { platform: process.platform };
  const command = `
    $ErrorActionPreference='Stop'
    $policy=Get-ItemProperty -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy' -ErrorAction SilentlyContinue
    $version=Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'
    $signature=if(Test-Path -LiteralPath $env:MOSAIC_DIAGNOSTIC_EXE){Get-AuthenticodeSignature -LiteralPath $env:MOSAIC_DIAGNOSTIC_EXE}else{$null}
    [pscustomobject]@{
      platform='win32'
      build=([string]$version.CurrentBuild+'.'+[string]$version.UBR)
      smartAppControl=$policy.VerifiedAndReputablePolicyState
      signature=if($signature){[string]$signature.Status}else{'Missing'}
      signer=if($signature.SignerCertificate){$signature.SignerCertificate.Subject}else{$null}
      administrator=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } | ConvertTo-Json -Compress
  `;
  const { stdout } = await execute(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    {
      windowsHide: true,
      timeout: 15000,
      env: { ...process.env, MOSAIC_DIAGNOSTIC_EXE: executable },
    },
  );
  return JSON.parse(stdout.replace(/^\uFEFF/, ''));
}

export function explainWindowsFailure(report) {
  if (report.signature === 'Missing')
    return '실행 파일이 없습니다. mosaic 폴더에서 npm run package:win을 실행해 주세요.';
  if (report.smartAppControl === 1 && report.signature !== 'Valid')
    return [
      'Windows 스마트 앱 컨트롤이 켜져 있고, 이 실행 파일에는 신뢰할 수 있는 서명이 없습니다.',
      '이 기능은 앱 하나만 예외로 허용할 수 없습니다. 다음 중 하나가 필요합니다.',
      /^(26100|26200|26300)\.9711$/.test(report.build||'') ? '현재 Windows 빌드는 다시 켜기 오류가 보고된 버전입니다. 끄기 전에 KB5127936 이후 업데이트 적용을 권장합니다.' : '',
      '1. 개발 PC: Windows 보안 > 앱 및 브라우저 컨트롤 > 스마트 앱 컨트롤 설정에서 직접 끄기.',
      '   PC 전체에 적용되는 설정입니다. 이 실행기는 보안 설정을 바꾸지 않습니다.',
      '2. 보호 유지: 신뢰할 수 있는 코드 서명 인증서로 앱을 서명해서 배포.',
      'PowerShell 실행 정책 변경이나 파일 차단 해제로 해결되는 문제가 아닙니다.',
      '자세한 안내: mosaic/docs/windows-runtime.md',
    ].filter(Boolean).join('\n');
  return '실행 오류를 확인해 주세요. npm run diagnose로 Windows 서명/정책 상태를 읽을 수 있습니다. 이 진단은 시스템 설정을 변경하지 않습니다.';
}
