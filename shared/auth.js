// kakeibo 共通認証モジュール（GASのAccessGate.html相当）
// 各画面は以下の順で読み込むこと：
//   1. <script>window.KAKEIBO_LIFF_ID = '...';</script>（画面ごとのLIFF ID）
//   2. LIFF SDK
//   3. supabase-js
//   4. このファイル
// 読み込み後、window.kakeiboSupabase（クライアント）と window.kakeiboReady（認証完了を
// 表すPromise<boolean>）が使える。falseの場合はLIFF外アクセス・トークン検証失敗等。

(function () {
  const SUPABASE_URL = 'https://gduznhcuyjxxyuhfexek.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdkdXpuaGN1eWp4eHl1aGZleGVrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI5NzMxMjYsImV4cCI6MjA4ODU0OTEyNn0.YxDgpDnNOws7IRdGzKDvh9mFmGgrQZU4XKWuJ81l_6E';
  const LIFF_ID = window.KAKEIBO_LIFF_ID;

  const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  window.kakeiboSupabase = supabaseClient;

  function withTimeout(promise, ms) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve({ timedOut: true }); } }, ms);
      promise.then((v) => { if (!done) { done = true; clearTimeout(timer); resolve({ value: v }); } })
             .catch((e) => { if (!done) { done = true; clearTimeout(timer); resolve({ error: e }); } });
    });
  }

  async function ensureSession() {
    try {
      const { data } = await supabaseClient.auth.getSession();
      if (data && data.session) return true;
    } catch (e) { /* fallthrough */ }

    if (typeof liff === 'undefined' || !LIFF_ID) return false;

    const initResult = await withTimeout(liff.init({ liffId: LIFF_ID }), 8000);
    if (initResult.timedOut || initResult.error) return false;

    if (!liff.isInClient || !liff.isInClient()) return false;

    let accessToken;
    try {
      accessToken = liff.getAccessToken();
    } catch (e) { return false; }
    if (!accessToken) return false;

    try {
      const res = await fetch(SUPABASE_URL + '/functions/v1/token-exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: accessToken })
      });
      if (!res.ok) return false;
      const payload = await res.json();
      const { error } = await supabaseClient.auth.verifyOtp({
        token_hash: payload.hashedToken,
        type: 'magiclink'
      });
      return !error;
    } catch (e) {
      return false;
    }
  }

  window.kakeiboReady = ensureSession();
})();
