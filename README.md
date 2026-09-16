# 마킹 저장소

[S3 Inventory Tree Viewer](../viewer)의 마킹을 담는 **공개** 저장소입니다. 뷰어에서 사람이 내린 판단이 이 저장소의 이슈로 쌓입니다.

이 저장소가 공개인 이유는 [utterances](https://utteranc.es/)가 방문자의 브라우저에서 이슈를 직접 읽어 오기 때문입니다. 비공개 저장소의 이슈는 표시되지 않습니다. 이슈 제목에 디렉터리 경로가 들어가므로 그 경로는 외부에 드러납니다.

## 뷰어에서 마킹하는 방법

**utterances 위젯은 코멘트만 남길 수 있고 라벨을 붙이지 못합니다.** 상태를 담는 것은 라벨이므로, 사람은 `/deletable` 같은 **명령**을 남기고 집계 워크플로가 그것을 읽어 라벨로 옮깁니다.

### 아직 마킹되지 않은 디렉터리

상세 패널의 상태 버튼을 누르면 `.github/ISSUE_TEMPLATE/mark.yml` 이슈 폼이 **값이 채워진 채로** 열립니다. 사람이 적을 것은 판단 근거 하나뿐입니다.

| 필드 | 뷰어가 채우는 값 |
| --- | --- |
| 제목 | `mark: projects/legacy-sim/` |
| 경로 | `projects/legacy-sim/` |
| 판단 | 누른 버튼에 해당하는 선택지 |
| 용량 | `5.3 TiB` |
| 파일 수 | `299,726개` |
| 뷰어 링크 | `https://<사이트>/#/projects/legacy-sim/` |
| 인벤토리 기준 | `2026-09-16 인벤토리` |
| 판단 근거 | 비어 있습니다. 사람이 적습니다. |

이슈 폼은 필드 id를 질의 문자열로 받아 값을 미리 채웁니다. 뷰어는 `?template=mark.yml&title=...&path=...&state=...` 형태로 주소를 만듭니다.

판단 드롭다운의 선택지는 `/deletable (백업하지 않고 지워도 됨)`처럼 **명령으로 시작합니다.** 폼이 만들어 낸 본문에서 워크플로가 그 명령을 읽어 라벨을 붙입니다. 라벨을 URL 파라미터로 직접 주지 않는 이유는 저장소에 쓰기 권한이 없는 사람은 그 방식으로 라벨을 달 수 없기 때문입니다.

용량과 파일 수는 **마킹한 시점의 값**이라 나중 인벤토리와 다를 수 있습니다. 그 차이 자체가 판단을 다시 볼 근거가 되므로 `marks.json`의 `at_marking`에 그대로 남깁니다.

폼을 직접 열어 채우는 것도 됩니다. 제목의 `mark: ` 뒤에 경로를 적지 않았더라도 워크플로가 **경로 필드를 보고 제목을 고쳐 줍니다.** 뷰어의 댓글 위젯이 제목으로 스레드를 찾기 때문에 제목이 맞아야 합니다.

### 이미 마킹된 디렉터리

상태 버튼을 누르면 명령이 클립보드에 복사됩니다. 아래 utterances 스레드에 붙여 넣고 Comment를 누르면 됩니다.

```
/backed-up
```

명령은 코멘트 어디에 있어도 되며, 앞뒤에 설명을 함께 적어도 인식합니다.

```
확인했고 S3로 옮겼습니다. /backed-up
```

집계는 30분마다, 그리고 이슈에 변화가 생길 때마다 돕니다. 반영되면 상세 패널의 새로고침을 누르세요.

## 상태와 명령

| 라벨 | 명령 | 의미 |
| --- | --- | --- |
| `deletable` | `/deletable` | 백업하지 않고 지워도 된다고 판단했습니다. |
| `keep` | `/keep` | 보관해야 하므로 지우면 안 된다고 판단했습니다. |
| `backup-requested` | `/backup-requested` | 백업을 요청했습니다. |
| `backed-up` | `/backed-up` | 백업이 끝났습니다. |
| `needs-triage` | | 집계 워크플로가 규칙에 맞지 않는다고 판단한 이슈입니다. |

### 누가 명령을 쓸 수 있나

**기본은 제한 없음입니다.** GitHub 계정만 있으면 누구나 마킹할 수 있고, 이 저장소에 collaborator로 추가할 필요가 없습니다. 판단을 남길 수 있는 사람을 미리 등록해 두는 운영 부담을 지지 않기 위해서입니다.

조이려면 워크플로에서 `ALLOW_ASSOCIATIONS`를 지정합니다. GitHub가 매기는 `author_association` 값 중 허용할 것만 적으면 됩니다.

```yaml
      - name: 이슈 집계
        env:
          ALLOW_ASSOCIATIONS: OWNER,MEMBER,COLLABORATOR
```

그 밖의 사람이 남긴 명령은 무시하고 로그에 이유를 남깁니다.

### 상태는 어떻게 정해지나

**라벨이 최종 상태이고 명령은 그 변경 요청입니다.** 워크플로는 지난 집계 뒤에 새로 들어온 명령만 라벨에 반영하고, 어디까지 반영했는지를 `marks.json`의 `command_at`에 남깁니다.

이 규칙 덕분에 두 가지가 모두 성립합니다. 뷰어에서 남긴 명령이 라벨이 되고, GitHub에서 손으로 고친 라벨을 다음 집계가 되돌려 놓지 않습니다.

## 이슈 폼

`.github/ISSUE_TEMPLATE/mark.yml`이 마킹 이슈의 모양을 정합니다. 필드는 경로, 판단, 판단 근거, 용량, 파일 수, 뷰어 링크, 인벤토리 기준이고 앞의 셋이 필수입니다.

이 파일은 세 곳과 맞물려 있습니다. 고칠 때 함께 확인하세요.

| 폼의 무엇 | 맞물린 곳 |
| --- | --- |
| 드롭다운 선택지 문구 | 뷰어 `web/marks.js`의 `STATES[].option` (글자 하나까지 같아야 합니다) |
| 필드 라벨 | `scripts/aggregate.mjs`의 `FIELD` (본문을 가를 때 씁니다) |
| 필드 id | 뷰어가 질의 문자열로 보내는 이름 |
| `title` 기본값 | 뷰어 `web/config.js`의 `marks.titlePrefix` |
| `labels` | 뷰어 `web/config.js`의 `marks.label` |

판단 필드는 판단 근거보다 **앞에** 있어야 합니다. 본문에서 처음 만나는 명령을 상태로 읽기 때문에, 근거 문장에 우연히 들어간 명령이 드롭다운 값을 덮지 않게 하기 위해서입니다.

## 이슈 규칙

제목은 `mark: <디렉터리 경로>` 형태입니다. 경로는 `/`로 끝납니다. 뷰어의 상태 버튼과 utterances 위젯이 이 제목을 자동으로 만들므로 사람이 직접 적을 일은 없습니다.

경로 하나에 이슈 하나가 원칙입니다. 번호가 가장 작은 이슈가 원본이고, 같은 경로를 가리키는 다른 이슈는 워크플로가 닫습니다.

## marks.json

`.github/workflows/aggregate.yml`이 이슈를 훑어 `marks.json`을 갱신합니다. 뷰어는 페이지에 들어올 때 이 파일 하나만 받습니다.

```
https://raw.githubusercontent.com/<OWNER>/<REPO>/main/marks.json
```

이 주소를 쓰는 이유는 `raw.githubusercontent.com`이 `Access-Control-Allow-Origin: *`를 응답해서 다른 도메인에 올라간 뷰어에서도 곧바로 가져올 수 있기 때문입니다.

브라우저에서 Issues API를 직접 부르지 않는 이유는 무인증 호출이 IP당 시간당 60회로 제한되기 때문입니다. 노드를 몇 번 펼치는 것만으로 한도에 닿습니다.

```json
{
  "generated_at": "2026-09-16T00:00:00Z",
  "triage": {
    "datasets/kitti/": { "issue": 22, "reason": "제목의 경로와 폼의 경로가 다릅니다" }
  },
  "counts": {
    "issues": 42, "marked": 37, "needs_triage": 2,
    "duplicates_closed": 3, "commands_applied": 5, "titles_fixed": 1
  },
  "marks": {
    "projects/legacy-sim/": {
      "state": "backup-requested",
      "issue": 42,
      "actor": "minhoryang",
      "updated_at": "2026-09-14T08:31:00Z",
      "command_at": "2026-09-14T08:31:00Z",
      "comments": 3,
      "closed": false,
      "at_marking": {
        "size": "5.3 TiB",
        "count": "299,726개",
        "inventory": "2026-09-16 인벤토리"
      }
    }
  }
}
```

`issue`는 언제나 원본 이슈의 번호입니다. 뷰어가 여는 스레드가 흔들리지 않아야 하기 때문입니다.

## 집계 워크플로가 하는 일

`issues` 이벤트가 생길 때마다 돌고, 30분마다 한 번 더 돕니다. 이슈 목록과 저장소 전체의 코멘트 목록을 각각 한 번씩 받아 오므로 API 호출은 한 자릿수로 끝납니다.

* 이슈 본문과 코멘트에서 상태 명령을 읽어 **라벨로 옮깁니다.** 폼이 만들어 낸 본문과 그냥 쓴 본문을 모두 읽습니다.
* 제목에 경로가 빠졌으면 폼의 경로 필드에서 살려내 **제목을 고칩니다.**
* 제목이 `mark: ` 규칙을 벗어났고 폼에도 경로가 없는 이슈에 `needs-triage` 라벨을 붙입니다.
* 제목의 경로와 폼의 경로가 다르거나 상태 라벨이 둘 이상 겹치는 이슈에도 `needs-triage`를 붙입니다. **이런 이슈는 상태를 정하지 않고 `marks.json`의 `triage`에만 남깁니다.** 무엇을 지울지 정하는 도구이므로 모호한 입력을 임의로 해석하지 않습니다. 뷰어는 해당 경로에 검토가 필요하다는 안내를 띄웁니다.
* 같은 경로를 가리키는 이슈가 여럿이면 번호가 가장 작은 것만 남기고 나머지는 원본을 가리키는 코멘트를 남긴 뒤 닫습니다. 닫히는 이슈에 판단이 담겨 있으면 그 판단을 원본으로 옮깁니다. 사람이 남긴 것을 조용히 버리지 않습니다.

`generated_at`만 바뀐 경우에는 커밋하지 않습니다. 30분마다 빈 커밋이 쌓이지 않게 하기 위해서입니다.

## 손으로 돌려 보기

```bash
GITHUB_REPOSITORY=<OWNER>/<REPO> GITHUB_TOKEN=<토큰> node scripts/aggregate.mjs --dry-run
```

`--dry-run`은 라벨을 붙이거나 이슈를 닫지 않고 결과만 출력합니다.

## 설정

1. 이 저장소를 **공개**로 만듭니다.
2. Settings → General → Features에서 Issues를 켭니다.
3. [utterances GitHub App](https://github.com/apps/utterances)을 이 저장소에 설치합니다.
4. 위 표의 라벨 다섯 개를 만듭니다. `.github/ISSUE_TEMPLATE/mark.yml`의 `labels`에 적힌 `mark`가 없으면 이슈 생성이 실패합니다.
5. 뷰어의 `web/config.js`에서 `marks.enabled`를 켜고 `marks.repo`와 `marks.marksUrl`을 이 저장소로 맞춥니다.
