# Windows 배포 절차

대상은 Windows x64의 Mosaic 0.7.4입니다. 일반 빌드·검사 명령은 외부에 게시하지 않습니다. 명시적으로 `publish-release.mjs --publish`를 실행하거나 GitHub의 **Prepare or publish Windows release**에서 `publish`를 선택한 경우에만 공개합니다. 계정 로그인·인증서 구매·Windows 보호 설정 변경은 자동으로 수행하지 않습니다.

## 자동 검증과 공개

1. 허용 목록으로 내보낸 소스만 독립 저장소에 넣습니다. 기존 작업 폴더 전체나 다른 저장소의 Git 이력을 올리지 않습니다.
2. 저장소 **Settings → Secrets and variables → Actions → Variables**에 선택한 PostHog 프로젝트의 `MOSAIC_TELEMETRY_HOST`와 `MOSAIC_POSTHOG_TOKEN`을 등록합니다. 공개 수집 토큰만 사용하며 관리 API 키는 넣지 않습니다.
3. **Actions → Prepare or publish Windows release**를 실행합니다. 기본값 `publish: false`는 빌드·core·UI·native·설치·감사를 수행하고 `mosaic-windows-release` 아티팩트만 7일 보관합니다.
4. 모든 공개 조건을 해결한 커밋에서 `publish: true`로 실행하면 같은 검사 후 파일을 draft release에 업로드하고 업로드가 끝난 뒤 공개합니다. `beta`는 prerelease, `stable`은 정식 릴리스입니다. 기존의 같은 버전 릴리스는 덮어쓰지 않습니다.
5. 공개 후 로그아웃한 환경에서 파일·소스·체크섬 다운로드와 이전 앱의 업데이트 확인을 검사합니다. 실패하여 draft가 남으면 해당 버전의 상태를 확인하고 복구하세요.

테스트 결과는 `node scripts/run-release-tests.mjs core`, `ui`, `native`로 기록합니다. 결과는 현재 소스 해시에 연결되고 native는 테스트한 앱 매니페스트에도 연결됩니다. `node scripts/collect-release.mjs --public`은 실제 설치 검사까지 최종 파일과 일치해야 통과합니다. `--draft`는 미완료 항목을 표시한 검토용 묶음만 만듭니다.

묶음은 `release/.bundles/` 아래의 출력된 폴더입니다. 설치 EXE, portable ZIP, 소스 ZIP, 매니페스트·SHA-256, 설명과 `RELEASE.json`만 포함합니다. 원시 로그·trace·브라우저 프로필은 업로드하지 않습니다. 게시 직전 저장소·소스 커밋·파일 해시를 다시 확인하며 쓰기 토큰은 공개 작업에만 부여합니다.

공개 묶음은 독립 저장소 루트에서 생성해야 하며 `origin`이 배포 대상과 같고 모든 감사 대상 파일의 목록·바이트가 지정한 커밋과 같아야 합니다. 미커밋 수정, 누락 파일 또는 추가 비공개 파일이 있으면 거부합니다. `.gitattributes`는 Windows 체크아웃의 줄바꿈 자동 변환을 막아 감사한 바이트를 유지합니다. 기존 버전 태그가 다른 커밋을 가리키는 경우에도 공개하지 않습니다.

호스팅된 CI에는 코드 서명 인증서가 없으므로 서명을 요구하는 배포는 승인한 서명 환경에서 준비해야 합니다. 서명 후 native·설치 검사를 다시 실행하고 `GITHUB_REPOSITORY`와 `GITHUB_SHA`를 실제 테스트한 소스 저장소·커밋으로 지정합니다. 공개 묶음을 만든 뒤 `node scripts/publish-release.mjs --check 폴더`로 확인하고, `--publish`로 게시합니다. 실제 게시에는 GitHub CLI 로그인이 필요합니다.

현재 개인용 Mosaic가 실행 중이거나 설치·바로가기가 있으면 설치 검사를 실행하지 말고 깨끗한 Windows CI를 이용하세요. `node scripts/verify-windows-artifacts.mjs`는 압축을 풀어 파일을 확인하지만 설치 프로그램을 실행하지 않으므로 실제 설치 검사와 구분합니다.

빌드 의존성 minimatch는 [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)에 대응해 영향받는 7–10 계열만 11.0.1로 고정합니다. `npm audit --audit-level=moderate`와 실제 패키징으로 검증하며 electron-builder가 자체 수정되면 override를 검토합니다.

## 현재 공개 차단 항목

`release.config.json`의 `repository`, `publisher`는 미정입니다. 문의 주소는 tensordev9@gmail.com이며, 라이선스는 PolyForm Noncommercial 1.0.0으로 설정되었습니다. 집계 프로젝트와 신뢰할 수 있는 코드 서명도 준비되어야 합니다. [집계 연결](analytics.md)에 따라 `telemetry.config.json`을 준비하고 배포 정보를 확정하세요. 공개 저장소는 확인된 `owner/repository` 형식만 사용하며 채널은 `beta` 또는 `stable`입니다.

문의 이메일 공개는 앱의 필수 조건이 아닙니다. 비공개로 내용을 받는 문의 폼을 준비하고 HTTPS 응답자 주소를 `supportUrl`에 설정하면 앱의 **문의하기** 버튼으로 연결됩니다. 이메일을 공개하지 않으려면 `supportEmail`은 `null`로 유지하세요. 두 값 모두 있으면 폼이 우선하지만 설정 파일 자체가 배포되므로 이메일도 공개됩니다. 편집자 전용 링크나 관리용 토큰을 넣지 마세요.

폼은 로그인하지 않은 외부 사용자도 제출 가능한지 확인하고, 응답 목록·결과 요약은 공개하지 마세요. 문의 내용과 선택적인 회신 주소 정도만 받으며, 개인 문의·삭제 요청을 관리자가 확인할 수 있어야 합니다. 공개 GitHub Issues는 일반 버그 제보용으로 안내하세요. 폼을 연결한 뒤 실제 제출·수신을 확인해야 하며, 코드 검사는 주소 형식만 검증합니다.

`check-release.mjs --draft`는 파일 준비·무결성·감사를 검사하면서 공개 차단 항목을 별도로 표시합니다. `--public`은 하나라도 남으면 실패합니다. 공개 검사 통과도 소유자의 법적 승인이나 네이티브·설치 검사 결과를 대신하지 않습니다.

## 빌드와 검사

공개용 소스 루트에서 Node.js 24와 npm, 설치된 Chrome을 사용하세요. 기존 앱과 개인 계정 프로필을 종료·보존하고 검사는 임시 폴더에서 수행합니다.

```powershell
npm ci
npm run build
npm run test:core
npm run test:e2e
node scripts/package-win.mjs
$releaseVersion = (Get-Content -Raw package.json | ConvertFrom-Json).version
$env:MOSAIC_TEST_EXECUTABLE = (Resolve-Path ("release/Mosaic-" + $releaseVersion + "-win-x64/Mosaic.exe")).Path
npm run test:desktop
Remove-Item Env:MOSAIC_TEST_EXECUTABLE
node scripts/build-installer.mjs
node scripts/smoke-installer.mjs --run
node scripts/export-source.mjs
node scripts/audit-publication.mjs --package
node scripts/check-release.mjs --draft
node scripts/check-release.mjs --public
```

이미 같은 버전의 실행 폴더가 있으면 검증된 폴더를 교체할지 확인하고 `node scripts/package-win.mjs --replace`로 그 버전만 다시 만듭니다. 모든 명령의 종료 코드를 확인하고 실패 후 다음 단계로 넘어가지 마세요. 마지막 `--public`은 현재 미정 사항이 남아 있는 동안 실패하는 것이 정상입니다.

설치 검사는 `release/.installer-smoke/` 아래의 고유한 테스트 폴더에서 설치·업그레이드·임시 프로필 실행·제거를 확인합니다. 기존 0.6.2 폴더가 있으면 이전 버전 파일을 테스트 위치에 복사해 업그레이드하고, 없으면 같은 버전 재설치만 확인했다고 기록합니다. 실제 설치, 실행 중인 Mosaic 또는 기존 바로가기가 있으면 검사를 거부합니다. 이런 경우 실제 사용 환경을 지우지 말고 깨끗한 Windows 검사 환경을 준비하세요. 이 검사는 모든 이전 버전의 데이터 마이그레이션을 증명하지 않습니다.

## 준비되는 파일

| 파일 | 내용 |
| --- | --- |
| `Mosaic-0.7.4-win-x64/` | 앱, 런타임, 사용자 문서와 고지 전체 |
| `Mosaic-0.7.4-win-x64-setup.exe` | 현재 사용자용 설치 파일 |
| `Mosaic-0.7.4-win-x64-portable.zip` | 전체 실행 폴더의 압축판 |
| `Mosaic-0.7.4-win-x64-artifacts.json` | 설치판·압축판의 크기와 SHA-256 |
| `Mosaic-0.7.4-win-x64-SHA256SUMS.txt` | 설치판·압축판 해시 |
| `Mosaic-0.7.4-source.zip` | 허용 목록을 통과한 소스·테스트·잠금 파일·문서 |
| `Mosaic-0.7.4-source-manifest.json` | 소스 파일별 크기와 SHA-256; ZIP 안에도 같은 `SOURCE-MANIFEST.json` 포함 |
| `Mosaic-0.7.4-source-SHA256SUMS.txt` | 소스 ZIP과 소스 매니페스트 해시 |
| `publication-audit.json` | 검사한 파일 목록과 값을 숨긴 발견 사항 |
| `release-check-draft.json`, `release-check-public.json` | 검사 범위, 파일 오류와 공개 차단 항목 |

설치 검사와 서명 도구는 별도 결과 JSON을 남깁니다. `BUILD-INFO.json`의 패키징 성공이나 `signed` 플래그만으로 실행 검증·서명 검증을 주장하지 않습니다. 공개 검사는 Windows에서 실제 EXE·DLL·NODE와 설치 파일의 Authenticode, 타임스탬프, 설정된 배포자와 인증서 이름 일치를 다시 확인합니다.

`npm run build`는 Vite 성공 후 `audit-publication.mjs --stamp-build`로 `dist/BUILD-SOURCE.json`에 UI 소스·공유 코드·설정·잠금 파일과 빌드 출력의 해시를 기록합니다. 릴리스 검사는 이 입력이 현재 소스와 같고 출력이 패키지 안의 파일과 같은지 확인합니다. 런타임 소스와 배포 문서도 패키지의 바이트와 직접 비교합니다. 이 기록은 정해진 빌드 명령을 순서대로 실행했다는 전제의 오래된 빌드 탐지 수단이며, 컴파일러나 빌드 환경에 대한 암호학적 증명은 아닙니다.

아티팩트 매니페스트의 `packageManifestSha256`은 설치판·압축판을 만들 때 사용한 앱 파일 목록에 연결합니다. 같은 버전으로 앱 폴더만 다시 만들어 이전 설치 파일이 남으면 검사를 통과하지 못합니다. 실제 설치 검사는 압축판·설치 파일을 풀어 앱 파일을 비교하며, 결과의 `passed`, `packageManifestSha256`와 `artifacts` 해시를 최종 파일과 대조해야 합니다. 해시가 달라졌다면 설치 검사를 다시 실행하세요.

## 소스 공개 감사

소스 선택은 `scripts/audit-publication.mjs`의 명시적 루트 파일과 소스 디렉터리·확장자 허용 목록을 따릅니다. 사용자 프로필, 세션·연결 데이터, `.env`, 암호화 저장소, 캐시, 로그, 테스트 trace, `docs/superpowers`, `.superpowers` 및 로컬 개발 기록은 빠집니다. 테스트는 포함되며 테스트·문서 속 실제 자격 증명 모양도 실패합니다. 심볼릭 링크와 외부 폴더로 연결되는 junction을 따라가지 않습니다.

검사는 알려진 토큰·비밀키, 충분한 엔트로피를 가진 자격 증명 리터럴, 개인 홈 경로와 일부 개인 이메일 패턴에 집중합니다. 모든 종류의 비밀이나 개인정보를 찾는 완전한 보안 감사는 아닙니다. 출력에 의심 값은 포함하지 않으며 규칙·상대 경로·줄 번호만 기록합니다. 외부 라이선스 고지는 저자 정보를 포함할 수 있어 원문을 보존하고 해시로 확인합니다.

ZIP에는 검사 시 읽은 바이트만 넣습니다. 파일 순서·타임스탬프를 고정하여 같은 소스는 같은 ZIP을 만들고 CRC와 SHA-256으로 확인합니다. 내보낸 뒤 소스를 변경하면 릴리스 검사에서 `source-stale`로 실패하므로 마지막 수정 후 다시 내보내세요. 다른 도구로 전체 작업 폴더를 통째로 압축하지 마세요.

## 서명과 공개 전 마무리

승인된 코드 서명 인증서를 준비한 뒤 `scripts/sign-win.mjs`의 사전 점검으로 실제 서명 대상과 도구를 확인하세요. 인증서 개인키를 소스나 CI 로그에 넣지 않습니다. 서명은 앱 파일의 해시를 바꾸므로 서명 후 매니페스트·설치 파일·압축판·체크섬을 재생성하고 최종 설치 파일도 서명·검증해야 합니다. 서명 도구가 제공하는 순서와 결과를 확인하고 마지막 공개 검사를 다시 실행하세요.

```powershell
node scripts/sign-win.mjs --plan
node scripts/sign-win.mjs --plan --certificate 인증서_SHA1_지문
node scripts/sign-win.mjs --sign --certificate 인증서_SHA1_지문
node scripts/sign-win.mjs --verify
```

`--sign`은 실제 인증서가 준비된 뒤에만 사용합니다. 런타임 서명 후 설치 파일·제거 프로그램·압축판을 다시 만들므로 최종 네이티브·설치 검사와 체크섬 검증도 다시 수행하세요. `publisher`는 사용한 인증서의 배포자 common name과 맞춰야 합니다.

배포자는 최종 네이티브 검사, 설치·업그레이드·제거 검사, 소스·패키지 감사, 의존성 취약점 검토와 실제 파일 서명을 검토합니다. 알려진 제한과 실제 검사 환경은 별도 검증 기록에 남기세요. 실제 계정 OAuth 성공, 모든 Windows/DPI 호환성, 전체 보안 감사 또는 사이트 작업 성공률을 fixture 검사에서 추론하지 않습니다.

`website/index.html`은 다운로드 페이지의 정적 초안이며 아직 다운로드를 제공하지 않습니다. 첫 공개 파일은 GitHub Releases에서 제공하고, 별도 웹사이트는 실제 공개 주소가 생긴 뒤 연결합니다. `.github/workflows/ci.yml`은 독립 저장소의 Windows 검사이며 `release.yml`은 위의 명시적 공개 작업입니다. 보안 제보 경로는 [SECURITY.md](../../SECURITY.md)에 있습니다.
