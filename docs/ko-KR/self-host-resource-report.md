# 로컬 스냅샷으로 자원 한도 살펴보기

[English](../self-host-resource-report.md) | 한국어

서버 메모리가 남아 있어도 API가 재시작할 수 있습니다. 앱과 봇 컴퓨터는 서로
다른 한도를 쓰기 때문입니다. 운영자 PC에서 읽기 전용 요약본을 만들고 웹 브라우저에서 열어 확인할 수 있습니다. Rakazo 계정이나 앱 프로세스에 클러스터
권한을 주지 않습니다.

현재 수집기는 Kubernetes의 API·worker Deployment, 그 Deployment에 속한 Pod,
선택한 컴퓨터 네임스페이스의 quota를 읽습니다. 요약본에는 Pod·노드 이름, 주소,
환경변수, 비밀값, 로그나 개별 컴퓨터 정보를 넣지 않습니다. 다만 Kubernetes는
**로컬 수집기**에 Deployment와 Pod의 원본을 반환하므로 신뢰하는 운영자만 실행해야
합니다. 요약본의 자원 수치도 운영 정보입니다. 안전하게 보관하고 사용 후 지우세요.
앱은 파일을 기기에서 읽으며 업로드하지 않습니다. 로그인한 사람은 누구나 이 도구를
열 수 있지만, 운영자가 파일을 전달하지 않는 한 서버 상태를 읽을 수 없습니다.

## 수집하고 열기

저장소의 Node·pnpm 준비를 마친 소스 체크아웃에서 실행합니다. `kubectl`은 올바른
클러스터를 바라봐야 하고, 아래 권한이 필요합니다. 이름은 실제 배포에 맞게 바꾸세요.
선택적 quota는 운영자가 전체를 볼 권한이 있는 전용 컴퓨터 네임스페이스에서만
지정합니다. 그렇지 않다면 `--computer-namespace`와 `--quota`를 모두 빼세요.

```sh
umask 077
REPORT_DIR=$(mktemp -d)
pnpm exec tsx packages/adapters/src/cli/resource-snapshot.ts \
  --namespace rakazo --api rakazo-api --worker rakazo-worker \
  --computer-namespace rakazo-sandboxes --quota rakazo-computers \
  > "$REPORT_DIR/resource-snapshot.json"
printf 'Snapshot directory: %s\n' "$REPORT_DIR"
```

컨테이너 이름 기본값은 각각 `api`, `worker`입니다. 다르면 `--api-container`,
`--worker-container`를 지정하세요. 웹 앱의 `/operator/resources`에서 **Open snapshot**을 눌러 파일을 엽니다. 모바일
브라우저에서도 사용할 수 있습니다. Electron과 네이티브 모바일 앱에는 이 로컬 파일
도구로 이동하는 메뉴가 없으므로 웹 페이지를 여세요. 다른 기기에서 수집했다면
신뢰할 수 있는 경로로 파일을 옮기세요.

**Plan capacity**에서 컴퓨터 대수와 한 대당 CPU·메모리를 입력하면 전체 합계를
볼 수 있습니다. **Download plan**은 이 계획과 스냅샷의 API·worker 요청량·한도를
CPU 밀리코어와 메모리 바이트 단위로 저장합니다. 계획은 검토용 JSON이며 매니페스트를
적용하거나 서버를 변경하지 않습니다. 실제 변경은 quota, 노드의 할당 가능량, DB·웹·
시스템과 다른 서비스의 여유를 검토한 뒤 운영 설정에서 수행하세요. 컴퓨터 요청량을
따로 지정하지 않으면 Kubernetes가 보통 한도를 요청량으로 복사합니다. 네임스페이스
quota는 모든 Pod의 합계이고 사용자별 컴퓨터 수 제한은 별개입니다. Pod를 교체하기 전
실행 중인 작업을 끝내고 컴퓨터 홈을 저장하세요. 실행 중 메모리 한도를 줄이지 마세요.

## 표시값을 해석할 때

- API·worker의 요청량과 한도는 **Deployment 템플릿의 인스턴스 한 개 기준**입니다.
  배포 중에는 기존 Pod 값과 다를 수 있습니다. 준비 개수는 Deployment 상태입니다.
- 사용량은 현재 소유 Pod의 표본 합계이며 metrics-server가 필요합니다. 측정할 수
  없으면 0이 아니라 `—`로 보입니다. 최고치나 장기 이력은 아닙니다.
- 재시작과 OOM은 현재 소유 Pod의 현재·직전 종료만 봅니다. 교체된 Pod의 이력은
  빠질 수 있습니다. match expression이 있는 selector도 아직 수집하지 않습니다.
  로컬 프로세스 수를 제한하기 위해 한 Deployment의 Pod가 32개를 넘으면 사용량은
  표시하지 않습니다.
  `OOMKilled`는 OOM의 증거지만 종료 코드 137만으로는 확정할 수 없습니다. 컨테이너
  한도와 노드 전체 부족은 필요시 시간과 컨테이너가 일치하는 커널 기록으로 구분합니다.
- 컴퓨터 quota 사용량은 설정된 한도처럼 quota에 부과된 합계이지 실제 CPU·RAM 순간
  사용량이 아닙니다. 공유 네임스페이스라면 다른 Pod도 포함될 수 있으므로 전용
  네임스페이스가 아니면 quota를 수집하지 않습니다.
- 스냅샷은 시간이 지나면 오래됩니다. 노드의 여유나 지연 원인은 포함하지 않습니다.
  대기열·첫 응답·도구·저장소·DB·외부 네트워크와 모델 대기를 나누어 확인하세요.
  한도를 올려도 메모리 증가 원인이 밝혀지거나 속도가 보장되는 것은 아닙니다.

## 운영자 권한

수집기는 앱 서비스 계정이 아니라 실행자의 kubeconfig를 씁니다.
[영문 문서의 두 Role 예제](../self-host-resource-report.md#operator-permissions)는
API·worker Deployment의 `get`, 앱 네임스페이스의 ReplicaSet·Pod `list`, 선택적 Pod
metrics `get`, 선택한 컴퓨터 quota `get`만 허용합니다. 신뢰할 수 있는 별도 운영자에게만
RoleBinding을 연결하세요. Rakazo 서비스 계정에 연결할 필요는 없습니다.

`list` 권한이 있으면 해당 네임스페이스의 **모든** Pod·ReplicaSet 명세를 볼 수
있습니다. 라벨 필터는 권한 경계가 아닙니다. 전용 앱 네임스페이스와 신뢰하는
운영자에게만 사용하고, 공유 네임스페이스에 이 도구 때문에 권한을 주지 마세요.
list가 없으면 Deployment 템플릿과 준비 상태만 볼 수 있습니다. metrics 권한이나
metrics-server가 없으면 사용량만 빠집니다. quota 권한이 없으면 컴퓨터 quota를 볼 수
없습니다. 노드·Secret·로그·exec·쓰기·클러스터 전체 권한은 필요하지 않습니다.
