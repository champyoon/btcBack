// Resolve identity only through Supabase Auth, then read that user's own profile.
export async function checkCoupangMember(req, env, fetcher) {
  const bearer = req.headers.get('Authorization');
  const failure = (error, status, stage) => ({ error, status, stage });
  if (!bearer || !/^Bearer \S+$/i.test(bearer)) return failure('authentication_required', 401, 'authentication');
  const base = env('SUPABASE_URL'), apiKey = env('SUPABASE_ANON_KEY');
  if (!base || !apiKey) return failure('configuration_missing', 503, 'authentication');
  const options = { headers: { apikey: apiKey, Authorization: bearer }, redirect: 'error' };
  let stage = 'authentication';
  try {
    const response = await fetcher(`${base}/auth/v1/user`, { ...options, signal: AbortSignal.timeout(15000) });
    if (!response.ok) return failure(response.status >= 500 ? 'account_check_failed' : 'invalid_session', response.status >= 500 ? 503 : 401, stage);
    const user = await response.json();
    if (typeof user?.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.id) || user.is_anonymous === true) return failure('invalid_session', 401, stage);
    stage = 'profile-check';
    const query = new URLSearchParams({ select: 'id,member_status,coupang_sub_id', id: `eq.${user.id}`, limit: '1' });
    const result = await fetcher(`${base}/rest/v1/profiles?${query}`, { ...options, signal: AbortSignal.timeout(15000) });
    if (!result.ok) return failure('account_check_failed', 503, stage);
    const profiles = await result.json();
    if (!Array.isArray(profiles)) return failure('account_check_failed', 503, stage);
    const profile = profiles.length === 1 ? profiles[0] : null;
    if (profile?.id !== user.id || profile.member_status !== 'APPROVED') return failure('coupang_access_unavailable', 403, stage);
    if (profile.coupang_sub_id === null || profile.coupang_sub_id === '') return failure('coupang_access_unassigned', 403, stage);
    if (typeof profile.coupang_sub_id !== 'string' || !/^channel(?:10|[1-9])$/.test(profile.coupang_sub_id)) return failure('coupang_access_unavailable', 403, stage);
    return { subId: profile.coupang_sub_id };
  } catch {
    return failure('account_check_failed', 503, stage);
  }
}
