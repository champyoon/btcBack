# Bitcoin 적립 신청 저장 설정

1. Supabase 프로젝트를 만든 뒤 SQL Editor에서 `reward_requests.sql` 전체를 실행합니다. 새 테이블 전용 SQL이며, 이미 테이블이 있으면 중단합니다. 기존 데이터를 삭제하지 마세요.
2. 프로젝트의 Connect 또는 Settings에서 Project URL을 확인합니다. API Keys에서 `sb_publishable_...` Publishable key 또는 Legacy 탭의 `anon` public key를 사용합니다. 두 키 모두 비로그인 요청에 anon 권한이 적용됩니다. `service_role` 및 `sb_secret_` 키는 사용하지 않습니다.
3. `reward.html` 상단 script의 `SUPABASE_URL`, `SUPABASE_ANON_KEY`를 교체합니다. URL 예: `https://YOUR_PROJECT_REF.supabase.co`. 키는 브라우저에 공개되므로 데이터 접근은 SQL 권한과 RLS로 제한합니다.
4. Supabase Data API가 활성화되어 있고 `public` 스키마가 노출되어 있는지 확인합니다. 별도 Auth 로그인이나 Anonymous Sign-In 활성화는 필요하지 않습니다.
5. 수정한 `reward.html`을 기존 GitHub Pages 배포 방식으로 배포합니다. CDN의 Supabase JS v2를 사용하므로 빌드는 필요 없습니다.

## 저장 및 권한

- 쇼핑몰은 화면의 선택 이름(예: 쿠팡)으로 저장합니다. 구매금액 `52,000`은 숫자 `52000`으로 변환합니다. 선택 항목의 빈 값은 SQL NULL입니다.
- UUID, 접수 시각, pending 상태는 DB가 생성합니다. 공개 클라이언트는 이 세 열을 지정할 수 없습니다.
- anon은 입력 열에 INSERT만 할 수 있습니다. SELECT/UPDATE/DELETE 권한과 정책은 없습니다. authenticated에도 권한을 부여하지 않습니다.
- 성공 응답을 받기 전에는 성공 화면을 표시하지 않습니다. INSERT 뒤 `.select()`를 붙이지 마세요. 조회 권한이 필요해집니다.
- 관리자는 Supabase Table Editor에서 내용을 확인합니다. 신청 저장 자체가 이메일 발송이나 Bitcoin 지급을 수행하지 않습니다.
- Lightning은 기본 형식만 검사합니다. invoice 서명/만료, 지급 가능 여부는 별도의 지급 과정에서 확인해야 합니다.
- 요청 중 버튼과 입력을 잠가 연속 제출을 방지합니다. 네트워크 응답 유실 시 실제 저장 여부는 알 수 없으므로 자동 재시도하지 않습니다. 새로고침/다른 탭의 동일 신청까지 막는 영구 중복 방지는 포함하지 않습니다.
- INSERT 전용 RLS는 신청 정보 조회를 막지만 공개 API의 스팸 입력을 막지는 않습니다. 운영 시 필요하면 서버 측 CAPTCHA/요청 제한을 추가하세요.

## 동작 테스트

1. 필수값을 비우거나 미래 구매일, 잘못된 이메일, 음수 금액을 넣으면 요청이 전송되지 않아야 합니다.
2. 테스트용 정보와 `52,000`, Lightning Address를 제출합니다. 버튼이 접수 중으로 바뀌고 한 번만 POST되는지 Network에서 확인합니다.
3. 성공 화면이 표시되면 Supabase Table Editor에서 `purchase_amount=52000`, `status=pending`, UUID와 created_at, 선택 항목 NULL을 확인합니다.
4. BOLT11 invoice를 사용한 제출도 확인합니다. 실제 지급은 실행하지 않습니다.
5. 개발자 도구에서 Supabase REST 요청을 차단하거나 오프라인 상태로 제출합니다. 성공 화면 없이 오류가 나오고 입력값이 유지되는지 확인합니다. 네트워크 실패/20초 시간 초과 후에는 접수 여부를 먼저 확인하세요.
6. URL/키 미설정 또는 CDN 로딩 실패 시 제출 버튼이 비활성화되고 안내와 콘솔 오류가 표시되어야 합니다.
7. SQL Editor에서 아래 권한 검사를 실행합니다. 모두 true여야 합니다.

```sql
select
  has_column_privilege('anon', 'public.reward_requests', 'email', 'INSERT') as can_insert_email,
  not has_column_privilege('anon', 'public.reward_requests', 'status', 'INSERT') as cannot_set_status,
  not has_column_privilege('anon', 'public.reward_requests', 'id', 'INSERT') as cannot_set_id,
  not has_table_privilege('anon', 'public.reward_requests', 'SELECT') as cannot_select,
  not has_table_privilege('anon', 'public.reward_requests', 'UPDATE') as cannot_update,
  not has_table_privilege('anon', 'public.reward_requests', 'DELETE') as cannot_delete;

select policyname, roles, cmd, with_check
from pg_policies
where schemaname = 'public' and tablename = 'reward_requests';
-- Expected: one INSERT policy for anon, with status = 'pending'.
```

실제 프로젝트 연결 정보는 미설정 상태이므로, 실제 저장과 RLS는 위 설정 후 확인해 주세요.

## 로컬 회귀 검사

`tests/reward-supabase.test.cjs`는 Playwright로 페이지를 열고 Supabase 클라이언트 경계만 모의 처리합니다. 실제 DB에 접속하지 않습니다. 필수값, 금액 변환, 중복 클릭, 성공/실패, 재시도, 설정 누락, 권한 키 차단, CDN 실패 및 반응형을 검사합니다.

Playwright가 설치된 개발 환경에서 `node tests/reward-supabase.test.cjs`로 실행합니다. 별도 위치에 설치된 경우 `PLAYWRIGHT_MODULE`에 해당 모듈 경로를 지정하세요. 기본 브라우저는 Windows Chrome이며, 다른 환경은 `CHROME_PATH`로 실행 파일 경로를 지정합니다. 이 도구는 개발 검증용이며 GitHub Pages 배포에는 필요 없습니다.

## 공식 문서

- https://supabase.com/docs/reference/javascript/installing
- https://supabase.com/docs/reference/javascript/insert
- https://supabase.com/docs/guides/database/postgres/row-level-security
