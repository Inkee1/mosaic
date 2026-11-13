# Mosaic 0.7.5

**여러 웹페이지와 AI를 한 화면에서. 화면마다 다른 계정으로, 필요한 작업을 나란히.**

**Your web pages and AI, side by side.** Keep separate accounts in each pane and work with AI on the pages you choose.

Mosaic is a Windows x64 desktop browser for arranging web pages and AI conversations in one workspace. The interface supports Korean and English. AI features require your own supported CLI installation and provider account.

## Changes / 변경 사항

- Connects optional usage counting to PostHog US with separate consent, off by default. Test traffic is excluded from the active-installation dashboard. / 별도 동의를 받는 미국 지역 사용량 집계를 연결하고 테스트 기록은 제외합니다.
- Publishes under an explicit unsigned-beta policy; stable releases still require verified signing. / 미서명 베타 정책을 적용하며 정식 채널은 검증된 서명이 필요합니다.

- Remembers site permission decisions during the app run and merges duplicate requests. Choices remain separate for each pane, site and capability. / 실행 중 사이트 권한 선택을 기억하고 중복 요청을 합칩니다.
- Preserves microphone permission when a later camera request is denied. / 카메라 요청을 거부해도 기존 마이크 허용은 유지합니다.
- Updates a vulnerable build dependency and verifies release tests against the exact source and Windows artifacts. / 빌드 의존성 취약점을 수정하고 검사 결과를 실제 배포 파일과 연결합니다.
- Prepares the pinned Electron runtime when packaging from a fresh dependency installation. / 새 개발 환경에서도 필요한 Electron 실행 파일을 준비한 뒤 패키징합니다.
- Adds bilingual issue reporting and private security reporting at tensordev9@gmail.com. / 한국어·영어 오류 제보와 비공개 보안 문의 경로를 제공합니다.

## Install / 설치

**Unsigned beta:** Windows may show an unknown-publisher or SmartScreen warning. Download from [Inkee1/mosaic Releases](https://github.com/Inkee1/mosaic/releases) and compare the SHA-256 checksum before running. Managed computers may block unsigned apps.

**미서명 베타:** Windows가 알 수 없는 게시자 또는 SmartScreen 경고를 표시할 수 있습니다. 공식 저장소에서 받고 SHA-256을 비교한 뒤 실행 여부를 결정하세요. 조직 정책에 따라 실행이 제한될 수 있습니다.

Use `Mosaic-0.7.5-win-x64-setup.exe`, or extract the complete `Mosaic-0.7.5-win-x64-portable.zip` and run `Mosaic.exe`. Save your work and close Mosaic before updating. User data is stored in `%APPDATA%\MosaicBrowser` and retained on uninstall.

설치 파일을 실행하거나 압축판 전체를 푼 뒤 `Mosaic.exe`를 실행하세요. 업데이트 전 작업을 저장하고 앱을 닫아 주세요. 제거 후에도 사용자 데이터는 유지됩니다.

Usage counting is optional and off by default. It counts consenting active installations, not verified individual people. Website compatibility varies; important site actions need direct confirmation. Permission choices may be requested again after restart or in another pane.

사용자 수 집계는 기본 꺼짐이며 동의한 활성 설치 수를 집계합니다. 모든 사이트의 호환성을 보장하지 않으며 중요한 작업 결과는 직접 확인하세요. 앱 재시작 또는 다른 화면에서는 권한을 다시 물을 수 있습니다.

Mosaic's own code is available under PolyForm Noncommercial 1.0.0. Commercial use and modification for commercial purposes require separate permission; third-party components keep their own licenses.

Mosaic 자체 코드는 PolyForm Noncommercial 1.0.0 조건으로 공개합니다. 상업적 사용·그 목적의 수정에는 별도 허락이 필요하며 타사 구성요소에는 각 원래 라이선스가 적용됩니다.
