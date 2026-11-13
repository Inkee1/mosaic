# 외부 구성요소와 고지 범위

Mosaic 배포본에는 아래 파일을 함께 보관합니다. 이 문서는 범위 안내이며 각 라이선스 원문을 대체하지 않습니다.

| 파일 | 범위 |
| --- | --- |
| `LICENSE` | 사용한 Electron 배포본의 라이선스 |
| `LICENSES.chromium.html` | Electron이 제공한 Chromium 및 포함 구성요소 고지 |
| `UI-LICENSES.txt` | 빌드에 묶인 React, React DOM, Lucide React 패키지의 설치된 라이선스 원문 |
| `THIRD-PARTY-NOTICES/NSIS-LICENSE.txt` | 설치 도구에 사용하는 NSIS 3.12 배포본의 고지 |
| `THIRD-PARTY-NOTICES/ELECTRON-BUILDER-LICENSE.txt` | electron-builder 26.18.0 고지 |
| `THIRD-PARTY-NOTICES/STDUTILS-LGPL.txt`, `STDUTILS-LGPL-CLARIFICATION.txt` | NSIS StdUtils의 LGPL 원문과 제작자 추가 설명; 두 파일 모두 같은 고지 폴더에 보관 |
| `THIRD-PARTY-NOTICES/7ZIP-LICENSE.txt`, `7ZIP-COPYING.txt` | 빌더가 사용하는 7-Zip 번들의 고지와 라이선스 원문; 두 파일 모두 같은 고지 폴더에 보관 |
| `MOSAIC-LICENSE.txt` | Mosaic 자체 코드의 PolyForm Noncommercial 1.0.0 라이선스 |

설치 도구가 포함하는 NSIS 실행 구성요소의 적용 조건과 고지도 배포자가 검토해야 합니다. 위 `THIRD-PARTY-NOTICES`의 여섯 원문은 소스의 `installer/`에도 같은 이름으로 보관하고 패키지에 그대로 복사합니다. 소스의 `package-lock.json`은 사용한 개발 의존성 버전을 고정합니다. Electron, Vite, TypeScript, Playwright, electron-builder 및 전이 의존성의 고지는 각 설치 패키지에 있습니다. 개발용 패키지 전체가 실행 폴더에 복사되는 것은 아닙니다.

AI CLI와 Google Chrome은 별도로 설치하는 외부 제품입니다. Mosaic 설치 파일에 그 제품의 실행 파일·계정·이용권을 포함하지 않습니다. 사용자가 선택한 웹사이트의 콘텐츠와 상표에도 각각의 권리가 적용됩니다.

현재 자동 검사는 런타임 고지 파일의 존재와 파일 해시를 확인합니다. 모든 전이 의존성의 법적 적합성을 감사한 결과는 아닙니다. upstream 고지의 저자 이메일은 정상적인 귀속 정보이므로 Electron·UI 고지 세 파일과 위 여섯 고지의 정확한 소스/배포 경로에는 개인 이메일·홈 경로 규칙만 적용하지 않습니다. 자격 증명 검사는 그대로 적용합니다. 다른 이름의 문서·파일은 이 예외에 해당하지 않습니다. 앱 코드, 빌드 JavaScript, 자체 문서와 테스트도 자격 증명 검사를 받습니다.

의존성 갱신 시 실제 번들에 새 구성요소가 들어가는지 확인하고 필요한 고지를 추가하세요. 개발 의존성의 취약점 검사와 런타임 의존성 검사를 구별하고, 알려진 항목의 영향·완화·갱신 계획을 해당 릴리스 검증 기록에 남기세요. 단순 패키지 개수나 고지 파일 존재만으로 안전성·법적 검토 완료를 선언하지 않습니다.
