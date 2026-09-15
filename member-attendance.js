// This date is for UI lookup only. The no-argument RPC owns the authoritative day.
function logicalDay() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0,10);
}

export function createAttendance({ client, row }) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'site-attendance-button'; button.hidden = true;
  const readyLabel = document.createElement('span'), statusLabel = document.createElement('span');
  readyLabel.className = 'attendance-ready'; statusLabel.className = 'attendance-status';
  const icon = document.createElement('span'), reward = document.createElement('span');
  icon.className = 'attendance-icon'; icon.textContent = '₿'; icon.setAttribute('aria-hidden','true');
  reward.className = 'attendance-reward'; reward.textContent = '· +100 sats';
  readyLabel.append(icon,document.createTextNode('출석 체크'),reward);
  button.append(readyLabel,statusLabel);
  row.append(button);
  const dialog = document.createElement('dialog');
  dialog.className = 'attendance-dialog';
  dialog.setAttribute('aria-labelledby','attendance-title');
  dialog.setAttribute('aria-describedby','attendance-description');
  const title = document.createElement('h2'), amount = document.createElement('p'), description = document.createElement('p'), confirm = document.createElement('button');
  title.id = 'attendance-title'; description.id = 'attendance-description';
  amount.className = 'attendance-amount';
  confirm.className = 'attendance-confirm'; confirm.type = 'button'; confirm.textContent = '확인';
  dialog.append(title,amount,description,confirm); document.body.append(dialog);
  let userId = null, version = 0, loading = false, busy = false, done = false, timer, navigate = false, statusDay;
  function render() {
    button.hidden = !userId;
    button.disabled = loading || busy || done;
    const showStatus = busy || loading || done;
    statusLabel.textContent = busy ? '처리 중...' : loading ? '확인 중...' : done ? '오늘 출석 완료 ✓' : '';
    button.replaceChildren(showStatus ? statusLabel : readyLabel);
  }
  function log(operation) { console.error(`[BTCBack attendance] ${operation} failed`); }
  function schedule() {
    clearTimeout(timer);
    const next = Date.parse(logicalDay() + 'T00:00:00Z') + 21 * 60 * 60 * 1000;
    timer = setTimeout(() => { if (userId && !busy && !dialog.open) void checkStatus(); }, Math.max(1000,next - Date.now() + 100));
  }
  async function checkStatus() {
    const owner = userId, current = ++version;
    if (!owner) return;
    statusDay = logicalDay();
    const key = `ATTENDANCE:${owner}:${statusDay.replaceAll('-','')}`;
    loading = true; done = false; render();
    try {
      const { data, error } = await client.from('rewards').select('user_id,source_txn_key,amount_sats,status')
        .eq('user_id',owner).eq('source_type','ATTENDANCE').eq('source_txn_key',key).eq('status','CONFIRMED').maybeSingle();
      if (current !== version) return;
      if (error) throw error;
      if (data && (data.user_id !== owner || data.source_txn_key !== key || data.status !== 'CONFIRMED' || String(data.amount_sats) !== '100')) throw new Error('Invalid status');
      done = Boolean(data);
    } catch { if (current === version) log('status read'); }
    finally { if (current === version) { loading = false; render(); schedule(); } }
  }
  function show(kind) {
    navigate = kind === 'success';
    title.textContent = kind === 'success' ? '출석 체크 완료!' : kind === 'already' ? '출석 안내' : '출석 체크 실패';
    amount.hidden = kind !== 'success'; amount.textContent = kind === 'success' ? '+100 sats' : '';
    description.textContent = kind === 'success' ? '적립 완료' : kind === 'already' ? '오늘은 이미 출석 체크를 완료했습니다.' : '출석 체크에 실패했습니다. 잠시 후 다시 시도해주세요.';
    if (!dialog.open) dialog.showModal();
    confirm.focus();
  }
  confirm.addEventListener('click', () => {
    const destination = navigate; dialog.close();
    if (destination) window.location.assign('dashboard.html');
  });
  // Native dialog handles Escape/focus trapping. Escape closes without navigation.
  dialog.addEventListener('close', () => {
    navigate = false;
    if (userId) {
      (button.disabled ? document.querySelector('.site-nav [aria-current="page"], .site-nav a') : button)?.focus();
      if (!busy && statusDay !== logicalDay()) void checkStatus();
      else schedule();
    }
  });
  button.addEventListener('click', async () => {
    if (!userId || busy || loading || done) return;
    const current = version;
    busy = true; render();
    try {
      const { data, error } = await client.rpc('check_attendance');
      if (current !== version) return;
      if (error) throw error;
      if (data?.success !== true || typeof data.already_attended !== 'boolean' ||
          data.reward_sats !== (data.already_attended ? 0 : 100) ||
          typeof data.attendance_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.attendance_date) ||
          new Date(data.attendance_date+'T00:00:00Z').toISOString().slice(0,10) !== data.attendance_date) throw new Error('Invalid result');
      done = true; statusDay = data.attendance_date; show(data.already_attended ? 'already' : 'success');
    } catch { if (current === version) { log('RPC'); show('error'); } }
    finally {
      busy = false; render();
      if (userId && !dialog.open && (current !== version || statusDay !== logicalDay())) void checkStatus();
    }
  });
  function setUser(user) {
    const next = user?.id || null;
    if (next !== userId) {
      ++version; clearTimeout(timer); userId = next; done = false; loading = false;
      if (dialog.open) dialog.close();
    }
    if (!next) { render(); return; }
    if (!busy && !loading && !dialog.open) void checkStatus();
  }
  render();
  return { setUser };
}
