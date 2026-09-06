# Bitcoin 적립 신청 저장 설정

1. Supabase 프로젝트를 만든 뒤 SQL Editor에서 `reward_requests.sql` 전체를 실행합니다. 새 테이블 전용 SQL이며, 이미 테이블이 있으면 중단합니다. 기존 데이터를 삭제하지 마세요.
2. 프로젝트의 Connect 또는 Settings에서 Project URL을 확인합니다. API Keys에서 `sb_publishable_...` Publishable key 또는 Legacy 탭의 `anon` public key를 사용합니다. 두 키 모두 비로그인 요청에 anon 권한이 적용됩니다. `service_role` 및 `sb_secret_` 키는 사용하지 않습니다.
3. `reward.html` 상단 script의 `SUPABASE_URL`, `SUPABASE_ANON_KEY`를 교체합니다. URL 예: `https://YOUR_PROJECT_REF.supabase.co`. 키는 브라우저에 공개되므로 데이터 접근은 SQL 권한과 RLS로 제한합니다.
4. Supabase Data API가 활성화되어 있고 `public` 스키마가 노출되어 있는지 확인합니다. 별도 Auth 로그인이나 Anonymous Sign-In 활성화는 필요하지 않습니다.
5. 수정한 `reward.html`을 기존 GitHub Pages 배포 방식으로 배포합니다. CDN의 Supabase JS v2를 사용하므로 빌드는 필요 없습니다.

## 저장 및 권한

- 쇼핑몰은 화면의 선택 이름(예: 쿠팡)으로 저장합니다. 구매금액 `52,000`은 숫자 `52000`으로 변환합니다. 선택 항목의 빈 값은 SQL NULL입니다.
- UUID, 접수 시각, pending 상태는 DB가 생성합니다. 공개 클라이언트는 이 세 열을 지정할 수 없습니다.
- anon은 입력 열에 INSERT만 할 수 있습니다. SELECT/UPDATE/DELETE 권한과 정책은 없습니다. 아래 관리자 설정을 적용하면 admin_users에 등록된 authenticated 사용자만 조회와 상태 변경을 할 수 있습니다.
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

실제 저장 및 프로젝트에 적용된 RLS는 위 설정 후 확인해 주세요.

## 관리자 설정

1. 기존 `reward_requests`가 있는 프로젝트의 SQL Editor에서 **`admin_setup.sql` 전체**를 한 번 실행합니다. `reward_requests.sql`을 다시 실행하지 않습니다. 이 마이그레이션은 기존 신청을 유지합니다. 이미 관리자 테이블이 있거나 기존 status에 허용되지 않은 값이 있으면 트랜잭션 전체가 중단됩니다. 임의로 테이블을 삭제하지 말고 기존 상태를 먼저 확인하세요.
2. Supabase **Authentication > Users > Add user > Create new user**에서 관리자 이메일과 강력한 비밀번호로 계정을 생성합니다. 이메일 확인 상태도 완료합니다. Email/Password 로그인이 활성화되어 있어야 합니다. 공개 회원가입은 이 기능에 필요하지 않습니다.
3. 해당 사용자의 UUID를 확인한 뒤 SQL Editor에서 아래 SQL의 UUID를 교체하여 실행합니다. 등록 이메일은 auth.users에서 가져오며, 실제 권한 기준은 user_id입니다.

```sql
insert into public.admin_users (user_id, email)
select id, email from auth.users
where id = 'YOUR_ADMIN_USER_UUID'::uuid;

select user_id, email, created_at from public.admin_users;
```

4. `admin-config.js`에는 현재 `reward.html`과 같은 공개 URL·키가 설정되어 있습니다. 프로젝트/키를 바꾸면 두 설정을 함께 갱신합니다. publishable/legacy anon key만 사용하고 service_role/secret key는 넣지 않습니다.
5. `admin.html`, `admin.js`, `admin-config.js`를 기존 GitHub Pages 방식으로 배포하고 `/admin.html`에서 로그인합니다. 빌드와 별도 서버는 필요 없습니다. 비밀번호와 관리자 세션은 공개 설정 파일에 저장하지 않습니다.

### 권한과 상태

- admin_users는 RLS를 사용하며 authenticated 사용자는 자기 user_id 행만 조회할 수 있습니다. 브라우저에서 관리자 등록·수정·삭제는 불가능합니다. 관리자 추가/해제는 SQL Editor에서만 수행합니다.
- 관리자 SELECT/UPDATE 정책은 `auth.uid()`와 admin_users를 대조합니다. 이메일 문자열이나 사용자 수정 가능 메타데이터로 권한을 결정하지 않습니다.
- 비관리자 authenticated 사용자는 신청 SELECT 결과가 빈 배열이고 UPDATE 대상도 0행입니다. anon은 기존 입력 열 INSERT만 유지하며 SELECT/UPDATE/DELETE는 권한 오류입니다. 관리자에게도 DELETE는 허용하지 않습니다.
- 기본 관리자 설정은 `UPDATE(status)`만 허용합니다. 아래 sats 마이그레이션 적용 후에는 `UPDATE(status, reward_sats)`만 허용합니다. 이름·이메일·구매금액·수령 정보 등 신청 본문은 수정할 수 없습니다.
- CHECK 제약으로 상태 값을 제한하고 트리거로 `pending → purchase_confirmed → reward_confirmed → paid`만 허용합니다. 어느 단계에서든 rejected로 변경할 수 있지만 rejected에서 복원하는 동작은 제공하지 않습니다. paid에서 rejected로 바꾸어도 Bitcoin을 환수하지 않습니다.
- paid 확인창은 실제 Bitcoin 지급 완료 확인용입니다. 이 페이지는 Bitcoin 송금이나 이메일 발송을 실행하지 않습니다.
- 상태 변경은 기존 status도 함께 대조합니다. 다른 관리자가 먼저 바꿨거나 권한이 해제되어 0행이 반환되면 실패로 안내합니다. 새로고침하여 확인하세요.
- 통계는 필터와 무관한 전체 건수이며, 목록은 필터 적용 후 최신순 25건씩 표시합니다. 통계와 목록은 별도 쿼리라 동시 접수 중에는 일시적으로 차이가 날 수 있습니다.
- 세션은 별도 키 `btcback-admin-auth`로 탭의 sessionStorage에 저장합니다. 로그아웃/세션 종료 시 목록과 상세 내용을 지웁니다. 관리자 권한을 제거하면 DB는 즉시 후속 조회/수정을 차단합니다. 이미 화면에 표시된 데이터는 다음 새로고침/권한 확인 또는 로그아웃 시 지워집니다.

### 관리자 테스트 순서

1. 비로그인 `/admin.html`에서 로그인 화면만 보이는지 확인합니다.
2. 비밀번호 오류 시 오류 안내가 나오는지 확인합니다.
3. admin_users에 없는 별도 Auth 계정으로 로그인하면 접근이 거부되는지 확인합니다. 이 계정으로 REST API를 직접 호출해도 신청 SELECT는 빈 결과, UPDATE는 0행이어야 합니다.
4. 등록된 관리자 계정으로 로그인한 뒤 전체 통계, 6개 필터, 페이지 이동과 상세 정보(주문번호, Lightning, 메모 포함)를 확인합니다.
5. 테스트 신청에 대해 구매 확인, 리워드 확정, 지급 완료의 확인창을 취소/승인하며 화면 갱신을 확인합니다. **paid는 실제 지급을 완료한 신청에서만 승인하세요.** 반려도 확인합니다.
6. 두 탭에서 같은 신청을 열고 먼저 한 탭에서 상태를 변경합니다. 다른 탭의 이전 상태 변경은 실패해야 합니다.
7. 네트워크 요청 차단 시 로그인/목록/상태 변경 오류를 확인합니다. 로그아웃 후 목록과 열린 상세 내용이 지워지는지 확인합니다.
8. 기존 reward.html의 공개 INSERT가 유지되는지 확인합니다. SQL Editor의 `pg_policies`에서 이 프로젝트에 추가로 적용된 무제한 SELECT/UPDATE 정책이 없는지 확인하세요. 이 SQL은 프로젝트의 기존 INSERT 정책만 재설정하며 알 수 없는 정책을 삭제하지 않습니다.

```sql
select schemaname, tablename, policyname, roles, cmd, qual, with_check
from pg_policies where schemaname = 'public'
and tablename in ('reward_requests', 'admin_users');
-- reward_requests: anon INSERT, admin SELECT, admin UPDATE only.
-- admin_users: authenticated SELECT own user_id only.

-- Remove an administrator (does not delete the Auth user):
-- delete from public.admin_users where user_id = 'USER_UUID'::uuid;
```

### 관리자 자동 검사

`tests/admin.test.cjs`는 Playwright 모의 Auth/DB로 로그인·권한 차단·필터·상세·상태 변경·확인창·로그아웃을 검증합니다. `tests/admin-sql.test.cjs`는 PGlite PostgreSQL에서 실제 RLS와 열 권한, 상태 전환 트리거를 검증하며, Supabase 프로젝트에는 접속하지 않습니다. PGlite 검사에서만 auth.users/auth.uid()를 최소 구성으로 대체합니다.

개발 도구가 설치되어 있다면 `node tests/admin.test.cjs`, `node tests/admin-sql.test.cjs`로 실행합니다. 별도 설치 위치는 `PLAYWRIGHT_MODULE`, `PGLITE_MODULE`, Chrome 실행 파일은 `CHROME_PATH`로 지정할 수 있습니다. 이 테스트 도구는 배포 파일의 의존성이 아닙니다.

## 확정 리워드(sats) 마이그레이션

이미 `admin_setup.sql`을 실행한 환경에서는 **`supabase/reward_sats_migration.sql`만** SQL Editor에서 실행합니다. 기존 관리자 설정 SQL을 다시 실행하지 않습니다. SQL 성공 후 새 `admin.html`과 `admin.js`를 배포하세요. 적용 전 새 화면을 먼저 배포하면 아직 없는 열 때문에 목록 조회가 실패할 수 있습니다.

### 기존 데이터 확인

마이그레이션 첫 SELECT는 쿠팡 외 쇼핑몰과 기존 reward_confirmed/paid 행을 표시합니다. 뒤의 트랜잭션은 다음 경우 전체 중단되어 데이터·권한·트리거 변경을 되돌립니다.

- 쿠팡 외 쇼핑몰이 한 건이라도 있음: 실제 구매 내역을 확인하고 운영자가 정리해야 합니다. 마이그레이션은 쇼핑몰을 임의로 쿠팡으로 바꾸거나 신청을 삭제하지 않습니다.
- reward_sats에 0/음수가 있음, 또는 기존 reward_confirmed/paid에 reward_sats가 없음: 실제 확정/지급 금액을 확인한 뒤 이력 데이터를 먼저 보완해야 합니다. 임의의 1 sats 등으로 통과시키지 마세요.

이미 확정/지급한 이력이 있어 중단되었다면, **실제 sats 수량을 확인한 경우에만** SQL Editor에서 아래 예시의 `VERIFIED_SATS`와 `REQUEST_UUID`를 교체하여 보완합니다. 이는 마이그레이션 적용 전 운영자의 이력 정리 절차입니다.

```sql
alter table public.reward_requests
  add column if not exists reward_sats bigint,
  add column if not exists reward_confirmed_at timestamptz,
  add column if not exists paid_at timestamptz;

update public.reward_requests
set reward_sats = VERIFIED_SATS
where id = 'REQUEST_UUID'::uuid
  and status in ('reward_confirmed', 'paid');
```

역사적 확정/지급 시각도 확인된 기록이 있을 때만 해당 행에 입력하세요. 알 수 없는 과거 시각은 NULL로 두며 `now()`로 위조하지 않습니다. 마이그레이션은 기존 금액과 시각을 덮어쓰지 않고, 이후 새 전환 시점부터 DB의 `now()`를 기록합니다. 사전 보완이 끝나면 마이그레이션 전체를 다시 실행합니다. 성공한 마이그레이션은 한 번만 적용합니다.

### 변경되는 권한과 제약

- nullable `reward_sats bigint`, `reward_confirmed_at timestamptz`, `paid_at timestamptz` 추가. sats는 NULL 또는 1 이상이며 reward_confirmed/paid 상태에서는 양수가 필수입니다.
- `store_name = '쿠팡'` CHECK로 브라우저를 우회한 다른 쇼핑몰 INSERT도 거부합니다.
- 테이블·열 권한을 재설정한 뒤 anon에는 기존 신청 입력 열 INSERT만, authenticated에는 SELECT와 `UPDATE(status, reward_sats)`만 부여합니다. 기존 admin_users 기반 RLS는 그대로 유지합니다.
- anon은 status·sats·확정/지급 시각을 지정할 수 없습니다. 관리자도 개인정보 및 timestamp를 직접 UPDATE할 수 없습니다.
- 기존 `validate_reward_status_transition()` 함수를 교체하고 `reward_status_transition` 트리거 하나만 유지합니다. UPDATE(status)뿐 아니라 reward_sats 변경도 검사합니다.
- sats는 `purchase_confirmed → reward_confirmed` 전환과 동시에만 변경 가능합니다. 확정 후 수량 수정, 상태 되돌리기, pending → paid 건너뛰기는 DB에서도 차단합니다.
- confirmed 시 reward_confirmed_at, paid 시 paid_at을 DB가 기록합니다. rejected로 변경해도 이미 기록된 수량·시각은 보존됩니다.

### 관리자 화면 테스트 순서

1. 관리자 로그인 후 pending 신청을 **구매 확인**하여 purchase_confirmed로 만듭니다.
2. 해당 행의 **확정 리워드**를 빈 값/0/음수/소수로 두고 **리워드 확정**을 누릅니다. 오류가 표시되고 UPDATE가 전송되지 않아야 합니다.
3. `350`을 입력하고 **리워드 확정** 확인창을 승인합니다. Network에서 `{ status: 'reward_confirmed', reward_sats: 350 }`의 UPDATE 한 번인지 확인합니다. timestamp는 요청에 없어야 합니다.
4. 목록/상세에서 `350 sats`, reward_confirmed, DB가 생성한 확정 시각을 확인합니다. 입력창은 더 이상 표시되지 않습니다. 통계·필터도 갱신되어야 합니다.
5. 지급은 외부 지갑에서 수동으로 진행합니다. **실제 Lightning 지급을 완료한 후에만** 지급 완료 확인창을 승인합니다. paid, 기존 sats·확정 시각, 새 지급 시각을 확인합니다.
6. 반려·필터·페이지 이동·로그아웃을 확인합니다. 실패나 동시 수정 충돌은 성공으로 표시되지 않아야 합니다.

화면 입력 상한은 JavaScript에서 정확히 처리 가능한 정수인 9,007,199,254,740,991 sats입니다. 시세 API·원화 환산·비율 계산·자동 송금은 없습니다. 지급 완료 기록은 송금의 증명이 아니므로 외부 지갑의 실제 거래 내역과 대조하세요.

### 자동 검증

- `node tests/reward-sats-sql.test.cjs`: 로컬 PGlite에서 충돌 롤백, 이력 보존, 단일 트리거, sats 필수/양수, DB 시각 생성, 순서 제약, 수량 수정 금지, anon/비관리자/관리자 권한, 쿠팡 CHECK를 검사합니다.
- `node tests/admin.test.cjs`: 모의 Auth/DB로 sats 오류·취소·단일 UPDATE·확정 이후 읽기 전용 표시·시각 표시와 기존 통계/필터/로그아웃/반응형을 검사합니다.
- 기존 관리자 SQL 검사는 `node tests/admin-sql.test.cjs`로 유지됩니다. 도구 경로 지정은 위 관리자 자동 검사와 동일합니다. 실제 Supabase 마이그레이션이나 송금은 테스트에서 실행하지 않습니다.

## 공개 신청 로컬 회귀 검사

`tests/reward-supabase.test.cjs`는 Playwright로 페이지를 열고 Supabase 클라이언트 경계만 모의 처리합니다. 실제 DB에 접속하지 않습니다. 필수값, 금액 변환, 중복 클릭, 성공/실패, 재시도, 설정 누락, 권한 키 차단, CDN 실패 및 반응형을 검사합니다.

Playwright가 설치된 개발 환경에서 `node tests/reward-supabase.test.cjs`로 실행합니다. 별도 위치에 설치된 경우 `PLAYWRIGHT_MODULE`에 해당 모듈 경로를 지정하세요. 기본 브라우저는 Windows Chrome이며, 다른 환경은 `CHROME_PATH`로 실행 파일 경로를 지정합니다. 이 도구는 개발 검증용이며 GitHub Pages 배포에는 필요 없습니다.

## 공식 문서

- https://supabase.com/docs/reference/javascript/installing
- https://supabase.com/docs/reference/javascript/insert
- https://supabase.com/docs/guides/database/postgres/row-level-security
